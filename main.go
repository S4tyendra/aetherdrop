package main

import (
	"fmt"
	"log"
	"os"

	"github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
)

// AetherDrop signaling server: room lobby + WebRTC signal relay.
// The frontend (UI/) is hosted separately; this server only does signaling.
func main() {
	h := newHub()

	// STUN_ADDR sets the UDP STUN listener; "off" disables it.
	if stunAddr := os.Getenv("STUN_ADDR"); stunAddr != "off" {
		if stunAddr == "" {
			stunAddr = "[::]:23478"
		}
		go serveSTUN(stunAddr)
	}

	app := fiber.New()

	app.Use(cors.New(cors.Config{
		AllowOrigins: "*",
		AllowHeaders: "Origin, Content-Type, Accept",
	}))

	app.Get("/healthz", func(c *fiber.Ctx) error { return c.SendString("ok") })

	app.Use("/ws", func(c *fiber.Ctx) error {
		if websocket.IsWebSocketUpgrade(c) {
			return c.Next()
		}
		return fiber.ErrUpgradeRequired
	})
	app.Get("/ws", websocket.New(h.serve))

	// LISTEN_ADDR overrides the bind address, e.g. 127.0.0.1:24032 behind Caddy.
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = "0.0.0.0:9032"
	}
	fmt.Printf("Signaling server running on %s\n", addr)
	log.Fatal(app.Listen(addr))
}
