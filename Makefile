# AetherDrop: Go signaling backend (VPS) + Astro frontend (Cloudflare Workers).
#
#   make build              build both
#   make build:backend      static Linux binary ./p2p-signal
#   make build:frontend     UI/dist
#   make deploy             deploy both
#   make deploy:backend     rsync binary to the VPS, restart the OpenRC user service
#   make deploy:frontend    wrangler deploy (worker "aetherdrop")

VPS     ?= vps
APP_DIR ?= /home/satya/myApps/p2p
SERVICE ?= p2p-signal
BIN     := p2p-signal
HEALTH  ?= https://p2p.devh.in/healthz

.PHONY: build build\:backend build\:frontend deploy deploy\:backend deploy\:frontend clean

build: build\:backend build\:frontend

build\:backend:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o $(BIN) .

UI/node_modules: UI/package.json
	cd UI && bun install
	@touch $@

build\:frontend: UI/node_modules
	cd UI && bun run build

deploy: deploy\:backend deploy\:frontend

# The VPS login shell is fish, so the remote steps run through sh.
deploy\:backend: build\:backend
	rsync -az $(BIN) $(VPS):$(APP_DIR)/$(BIN).new
	ssh $(VPS) 'sh -c "cd $(APP_DIR) && mv $(BIN).new $(BIN) && XDG_RUNTIME_DIR=/run/user/1000 rc-service --user $(SERVICE) restart"'
	@sleep 1; curl -fsS $(HEALTH) && echo " backend healthy"

deploy\:frontend: build\:frontend
	cd UI && bunx wrangler deploy

clean:
	rm -rf $(BIN) UI/dist
