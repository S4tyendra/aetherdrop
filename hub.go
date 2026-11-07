package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"log"
	"net"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gofiber/contrib/websocket"
)

const (
	maxMembers    = 2
	emptyRoomTTL  = 10 * time.Minute
	maxRooms      = 500
	maxRoomsPerIP = 10
	maxNameLen    = 40
	maxNickLen    = 24
	pinFailLimit  = 5               // wrong PINs per IP per room…
	pinFailWindow = 5 * time.Minute // …within this window
	pingEvery     = 20 * time.Second
	pongWait      = 50 * time.Second // no pong/message for this long → session is dead
	writeWait     = 5 * time.Second
	maxMsgBytes   = 256 << 10
)

// ─── Connection ─────────────────────────────────────────────────────────────

// safeConn serialises writes; websocket framing is not goroutine-safe.
type safeConn struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (s *safeConn) writeJSON(v any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(writeWait))
	return s.conn.WriteJSON(v)
}

func (s *safeConn) ping() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait))
}

func (s *safeConn) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.conn.Close()
}

// ─── Model ──────────────────────────────────────────────────────────────────

type session struct {
	id     string
	client string // stable per page load; survives websocket reconnects
	nick   string // display name the visitor picked
	ip     string
	conn   *safeConn
	room   string
}

type room struct {
	id         string
	name       string
	salt       []byte
	pinHash    []byte // nil → open room
	members    []*session
	createdAt  time.Time
	emptySince time.Time
	ownerIP    string
}

type roomInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Locked    bool   `json:"locked"`
	Members   int    `json:"members"`
	Max       int    `json:"max"`
	CreatedAt int64  `json:"createdAt"`
}

type peerInfo struct {
	ID     string `json:"id"`
	Client string `json:"client"`
	Name   string `json:"name"`
}

func (s *session) peer() peerInfo { return peerInfo{s.id, s.client, s.nick} }

// cleanNick trims a display name and drops control characters.
func cleanNick(n string) string {
	n = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.TrimSpace(n))
	if utf8.RuneCountInString(n) > maxNickLen {
		n = string([]rune(n)[:maxNickLen])
	}
	return strings.TrimSpace(n)
}

func (r *room) info() roomInfo {
	return roomInfo{r.id, r.name, r.pinHash != nil, len(r.members), maxMembers, r.createdAt.UnixMilli()}
}

func (r *room) checkPin(pin string) bool {
	if r.pinHash == nil {
		return true
	}
	h := hashPin(r.salt, pin)
	return subtle.ConstantTimeCompare(h, r.pinHash) == 1
}

func hashPin(salt []byte, pin string) []byte {
	h := sha256.New()
	h.Write(salt)
	h.Write([]byte(pin))
	return h.Sum(nil)
}

type failWindow struct {
	count int
	until time.Time
}

// outbound message, sent after the hub lock is released
type out struct {
	to *safeConn
	v  any
}

type hub struct {
	mu       sync.Mutex
	sessions map[string]*session
	rooms    map[string]*room
	fails    map[string]*failWindow // key: ip|room
}

func newHub() *hub {
	h := &hub{
		sessions: map[string]*session{},
		rooms:    map[string]*room{},
		fails:    map[string]*failWindow{},
	}
	go h.janitor()
	return h
}

func flush(msgs []out) {
	for _, m := range msgs {
		_ = m.to.writeJSON(m.v)
	}
}

// generateID creates a random string without the confusable 0, O, 1, I.
func generateID(length int) string {
	const charset = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := make([]byte, length)
	if _, err := rand.Read(b); err != nil {
		log.Fatalf("crypto/rand failure: %v", err)
	}
	for i := range b {
		b[i] = charset[int(b[i])%len(charset)]
	}
	return string(b)
}

// ─── Lobby snapshot ─────────────────────────────────────────────────────────

func (h *hub) roomList() []roomInfo {
	list := make([]roomInfo, 0, len(h.rooms))
	for _, r := range h.rooms {
		list = append(list, r.info())
	}
	sort.Slice(list, func(i, j int) bool { return list[i].CreatedAt > list[j].CreatedAt })
	return list
}

// lobbyUpdate queues the room list for every session that is not in a room.
func (h *hub) lobbyUpdate() []out {
	msg := map[string]any{"type": "rooms", "rooms": h.roomList()}
	var msgs []out
	for _, s := range h.sessions {
		if s.room == "" {
			msgs = append(msgs, out{s.conn, msg})
		}
	}
	return msgs
}

// ─── Room membership ────────────────────────────────────────────────────────

// leaveLocked removes s from its room. Caller holds h.mu.
func (h *hub) leaveLocked(s *session) []out {
	if s.room == "" {
		return nil
	}
	r := h.rooms[s.room]
	s.room = ""
	if r == nil {
		return nil
	}
	var msgs []out
	kept := r.members[:0]
	for _, m := range r.members {
		if m != s {
			kept = append(kept, m)
			msgs = append(msgs, out{m.conn, map[string]any{"type": "peer-left", "peer": s.peer()}})
		}
	}
	r.members = kept
	if len(r.members) == 0 {
		r.emptySince = time.Now()
	}
	return msgs
}

func (h *hub) janitor() {
	t := time.NewTicker(30 * time.Second)
	for range t.C {
		h.mu.Lock()
		changed := false
		now := time.Now()
		for id, r := range h.rooms {
			if len(r.members) == 0 && now.Sub(r.emptySince) > emptyRoomTTL {
				delete(h.rooms, id)
				changed = true
				log.Printf("room %s expired", id)
			}
		}
		for k, f := range h.fails {
			if now.After(f.until) {
				delete(h.fails, k)
			}
		}
		var msgs []out
		if changed {
			msgs = h.lobbyUpdate()
		}
		h.mu.Unlock()
		flush(msgs)
	}
}

// ─── Messages ───────────────────────────────────────────────────────────────

type inMsg struct {
	Type   string          `json:"type"`
	Name   string          `json:"name"`
	Pin    string          `json:"pin"`
	Room   string          `json:"room"`
	Client string          `json:"client"`
	Nick   string          `json:"nick"`
	Data   json.RawMessage `json:"data"`
}

func validPin(p string) bool {
	if len(p) < 4 || len(p) > 8 {
		return false
	}
	for _, c := range p {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func (h *hub) handle(s *session, m inMsg) {
	h.mu.Lock()
	var msgs []out
	reply := func(v any) { msgs = append(msgs, out{s.conn, v}) }

	switch m.Type {
	case "list":
		reply(map[string]any{"type": "rooms", "rooms": h.roomList()})

	case "create":
		name := strings.TrimSpace(m.Name)
		if utf8.RuneCountInString(name) > maxNameLen {
			name = string([]rune(name)[:maxNameLen])
		}
		pin := strings.TrimSpace(m.Pin)
		owned := 0
		for _, r := range h.rooms {
			if r.ownerIP == s.ip {
				owned++
			}
		}
		switch {
		case pin != "" && !validPin(pin):
			reply(map[string]any{"type": "create-error", "reason": "bad_pin_format"})
		case len(h.rooms) >= maxRooms:
			reply(map[string]any{"type": "create-error", "reason": "too_many_rooms"})
		case owned >= maxRoomsPerIP:
			reply(map[string]any{"type": "create-error", "reason": "too_many_rooms_ip"})
		default:
			id := generateID(5)
			for h.rooms[id] != nil {
				id = generateID(5)
			}
			if name == "" {
				name = "Room " + id
			}
			r := &room{id: id, name: name, createdAt: time.Now(), emptySince: time.Now(), ownerIP: s.ip}
			if pin != "" {
				r.salt = make([]byte, 16)
				_, _ = rand.Read(r.salt)
				r.pinHash = hashPin(r.salt, pin)
			}
			h.rooms[id] = r
			log.Printf("room %s created by %s", id, s.id)
			reply(map[string]any{"type": "created", "room": r.info()})
			msgs = append(msgs, h.lobbyUpdate()...)
		}

	case "join":
		r := h.rooms[strings.ToUpper(strings.TrimSpace(m.Room))]
		if m.Client != "" && len(m.Client) <= 64 {
			s.client = m.Client
		}
		s.nick = cleanNick(m.Nick)
		if r == nil {
			reply(map[string]any{"type": "join-error", "reason": "not_found"})
			break
		}
		if s.room == r.id {
			break
		}
		failKey := s.ip + "|" + r.id
		if f := h.fails[failKey]; f != nil && f.count >= pinFailLimit && time.Now().Before(f.until) {
			reply(map[string]any{"type": "join-error", "reason": "too_many_attempts"})
			break
		}
		if !r.checkPin(m.Pin) {
			f := h.fails[failKey]
			if f == nil || time.Now().After(f.until) {
				f = &failWindow{}
				h.fails[failKey] = f
			}
			f.count++
			f.until = time.Now().Add(pinFailWindow)
			reason := "bad_pin"
			if m.Pin == "" {
				reason = "pin_required"
			}
			reply(map[string]any{"type": "join-error", "reason": reason})
			break
		}
		// Same page reconnecting: evict its stale session instead of counting it twice.
		for _, old := range r.members {
			if old != s && s.client != "" && old.client == s.client {
				msgs = append(msgs, h.leaveLocked(old)...)
				break
			}
		}
		if len(r.members) >= maxMembers {
			reply(map[string]any{"type": "join-error", "reason": "full"})
			break
		}
		msgs = append(msgs, h.leaveLocked(s)...)
		peers := make([]peerInfo, 0, len(r.members))
		for _, p := range r.members {
			peers = append(peers, p.peer())
			msgs = append(msgs, out{p.conn, map[string]any{"type": "peer-joined", "peer": s.peer()}})
		}
		r.members = append(r.members, s)
		s.room = r.id
		reply(map[string]any{"type": "joined", "room": r.info(), "self": s.id, "peers": peers})
		msgs = append(msgs, h.lobbyUpdate()...)

	case "leave":
		msgs = append(msgs, h.leaveLocked(s)...)
		reply(map[string]any{"type": "left"})
		msgs = append(msgs, h.lobbyUpdate()...)

	case "signal":
		// Relay WebRTC signaling to the other member(s) of the sender's room.
		if r := h.rooms[s.room]; r != nil && len(m.Data) > 0 {
			for _, p := range r.members {
				if p != s {
					msgs = append(msgs, out{p.conn, map[string]any{"type": "signal", "from": s.id, "data": m.Data}})
				}
			}
		}
	}
	h.mu.Unlock()
	flush(msgs)
}

// clientIP returns the visitor's address for rate limits. We listen on
// loopback behind Caddy, which overwrites X-Forwarded-For with the real peer
// (it ignores client-sent values unless trusted_proxies is configured), so the
// first entry is trustworthy. Cf-Connecting-Ip is deliberately not used: with
// DNS-only records any client could forge it.
func clientIP(c *websocket.Conn) string {
	if xff := c.Headers("X-Forwarded-For"); xff != "" {
		first, _, _ := strings.Cut(xff, ",")
		if ip := net.ParseIP(strings.TrimSpace(first)); ip != nil {
			return ip.String()
		}
	}
	return c.IP()
}

// serve runs one websocket session until it closes or stops answering pings.
func (h *hub) serve(c *websocket.Conn) {
	ip := clientIP(c)
	sc := &safeConn{conn: c}
	s := &session{conn: sc, ip: ip}

	h.mu.Lock()
	for {
		s.id = generateID(8)
		if h.sessions[s.id] == nil {
			break
		}
	}
	h.sessions[s.id] = s
	list := h.roomList()
	h.mu.Unlock()

	c.SetReadLimit(maxMsgBytes)
	_ = c.SetReadDeadline(time.Now().Add(pongWait))
	c.SetPongHandler(func(string) error { return c.SetReadDeadline(time.Now().Add(pongWait)) })

	done := make(chan struct{})
	go func() {
		t := time.NewTicker(pingEvery)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				if err := sc.ping(); err != nil {
					sc.close()
					return
				}
			}
		}
	}()

	defer func() {
		close(done)
		h.mu.Lock()
		msgs := h.leaveLocked(s)
		delete(h.sessions, s.id)
		msgs = append(msgs, h.lobbyUpdate()...)
		h.mu.Unlock()
		flush(msgs)
		sc.close()
	}()

	if err := sc.writeJSON(map[string]any{"type": "welcome", "id": s.id, "rooms": list}); err != nil {
		return
	}

	for {
		var m inMsg
		if err := c.ReadJSON(&m); err != nil {
			return // closed, broken, or timed out without a pong
		}
		_ = c.SetReadDeadline(time.Now().Add(pongWait))
		h.handle(s, m)
	}
}
