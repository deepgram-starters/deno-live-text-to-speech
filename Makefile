# Deno Live Text-to-Speech Makefile
# Framework-agnostic commands for managing the project and git submodules

.PHONY: help check-prereqs init install build start start-backend start-frontend clean status update

# Default target: show help
help:
	@echo "Deno Live Text-to-Speech - Available Commands"
	@echo "========================================"
	@echo ""
	@echo "Setup:"
	@echo "  make check-prereqs  Check if prerequisites are installed"
	@echo "  make init           Initialize submodules and cache dependencies"
	@echo ""
	@echo "Development:"
	@echo "  make start          Start development servers (backend + frontend)"
	@echo "  make start-backend  Start backend server only"
	@echo "  make start-frontend Start frontend server only"
	@echo "  make build          Build frontend for production"
	@echo ""
	@echo "Maintenance:"
	@echo "  make update         Update submodules to latest commits"
	@echo "  make clean          Remove build artifacts"
	@echo "  make status         Show git and submodule status"
	@echo ""

# Check prerequisites
check-prereqs:
	@command -v git >/dev/null 2>&1 || { echo "❌ git is required but not installed. Visit https://git-scm.com"; exit 1; }
	@command -v deno >/dev/null 2>&1 || { echo "❌ deno is required but not installed. Visit https://deno.land"; exit 1; }
	@command -v pnpm >/dev/null 2>&1 || { echo "⚠️  pnpm not found. Run: corepack enable"; exit 1; }
	@echo "✓ All prerequisites installed"

# Initialize project: clone submodules and cache dependencies
init:
	@echo "==> Initializing submodules..."
	git submodule update --init --recursive
	@echo ""
	@echo "==> Caching Deno dependencies..."
	deno task cache
	@echo ""
	@echo "==> Installing frontend dependencies..."
	cd frontend && corepack pnpm install
	@echo ""
	@echo "✓ Project initialized successfully!"
	@echo ""
	@echo "Next steps:"
	@echo "  1. Copy sample.env to .env and add your DEEPGRAM_API_KEY"
	@echo "  2. Run 'make start' to start development servers"
	@echo ""

# Build frontend for production
build:
	@echo "==> Building frontend..."
	@if [ ! -d "frontend" ] || [ -z "$$(ls -A frontend)" ]; then \
		echo "❌ Error: Frontend submodule not initialized. Run 'make init' first."; \
		exit 1; \
	fi
	cd frontend && corepack pnpm build
	@echo "✓ Frontend built to frontend/dist/"

# Start both servers (backend + frontend)
start:
	@$(MAKE) start-backend & $(MAKE) start-frontend & wait

# Start backend server
start-backend:
	@if [ ! -f ".env" ]; then \
		echo "❌ Error: .env file not found. Copy sample.env to .env and add your DEEPGRAM_API_KEY"; \
		exit 1; \
	fi
	@echo "==> Starting backend on http://localhost:8081"
	deno task start-backend

# Start frontend dev server
start-frontend:
	@if [ ! -d "frontend" ] || [ -z "$$(ls -A frontend)" ]; then \
		echo "❌ Error: Frontend submodule not initialized. Run 'make init' first."; \
		exit 1; \
	fi
	@echo "==> Starting frontend on http://localhost:8080"
	cd frontend && corepack pnpm run dev -- --port 8080 --no-open

# Update submodules to latest commits
update:
	@echo "==> Updating submodules..."
	git submodule update --remote --merge
	@echo "✓ Submodules updated"

# Clean build artifacts
clean:
	@echo "==> Cleaning build artifacts..."
	rm -rf frontend/node_modules
	rm -rf frontend/dist
	@echo "✓ Cleaned successfully"

# Show git and submodule status
status:
	@echo "==> Repository Status"
	@echo "====================="
	@echo ""
	@echo "Main Repository:"
	git status --short
	@echo ""
	@echo "Submodule Status:"
	git submodule status
	@echo ""
	@if [ -d "frontend" ] && [ -n "$$(ls -A frontend)" ]; then \
		echo "Submodule Branches:"; \
		cd frontend && echo "frontend: $$(git branch --show-current) ($$(git rev-parse --short HEAD))"; \
	fi
	@echo ""
