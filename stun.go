package main

import (
	"encoding/binary"
	"log"
	"net"
)

// Minimal STUN (RFC 5389) Binding responder, so browsers learn their public
// IPv4/IPv6 addresses from our own server instead of a third party. It only
// answers Binding requests; it relays nothing (no TURN), so peer traffic never
// touches this server.

const (
	stunMagic       = 0x2112A442
	stunBindingReq  = 0x0001
	stunBindingResp = 0x0101
	attrXorMapped   = 0x0020
	attrSoftware    = 0x8022
)

func serveSTUN(addr string) {
	conn, err := net.ListenPacket("udp", addr) // "[::]:port" is dual-stack on Linux
	if err != nil {
		log.Printf("stun: listen %s: %v (STUN disabled)", addr, err)
		return
	}
	log.Printf("STUN responder on udp %s", addr)
	buf := make([]byte, 1500)
	for {
		n, from, err := conn.ReadFrom(buf)
		if err != nil {
			continue
		}
		resp := stunResponse(buf[:n], from.(*net.UDPAddr))
		if resp != nil {
			_, _ = conn.WriteTo(resp, from)
		}
	}
}

func stunResponse(req []byte, from *net.UDPAddr) []byte {
	if len(req) < 20 || req[0]&0xC0 != 0 {
		return nil
	}
	if binary.BigEndian.Uint16(req[0:2]) != stunBindingReq || binary.BigEndian.Uint32(req[4:8]) != stunMagic {
		return nil
	}
	if int(binary.BigEndian.Uint16(req[2:4]))+20 != len(req) {
		return nil
	}
	txID := req[8:20]

	// XOR-MAPPED-ADDRESS
	var value []byte
	port := uint16(from.Port) ^ uint16(stunMagic>>16)
	if ip4 := from.IP.To4(); ip4 != nil {
		value = make([]byte, 8)
		value[1] = 0x01
		binary.BigEndian.PutUint16(value[2:4], port)
		x := binary.BigEndian.Uint32(ip4) ^ stunMagic
		binary.BigEndian.PutUint32(value[4:8], x)
	} else {
		ip6 := from.IP.To16()
		value = make([]byte, 20)
		value[1] = 0x02
		binary.BigEndian.PutUint16(value[2:4], port)
		key := make([]byte, 16)
		binary.BigEndian.PutUint32(key[0:4], stunMagic)
		copy(key[4:], txID)
		for i := 0; i < 16; i++ {
			value[4+i] = ip6[i] ^ key[i]
		}
	}

	attrs := appendAttr(nil, attrXorMapped, value)
	attrs = appendAttr(attrs, attrSoftware, []byte("aetherdrop"))

	resp := make([]byte, 20, 20+len(attrs))
	binary.BigEndian.PutUint16(resp[0:2], stunBindingResp)
	binary.BigEndian.PutUint16(resp[2:4], uint16(len(attrs)))
	binary.BigEndian.PutUint32(resp[4:8], stunMagic)
	copy(resp[8:20], txID)
	return append(resp, attrs...)
}

func appendAttr(b []byte, typ uint16, v []byte) []byte {
	var h [4]byte
	binary.BigEndian.PutUint16(h[0:2], typ)
	binary.BigEndian.PutUint16(h[2:4], uint16(len(v)))
	b = append(b, h[:]...)
	b = append(b, v...)
	for len(b)%4 != 0 {
		b = append(b, 0)
	}
	return b
}
