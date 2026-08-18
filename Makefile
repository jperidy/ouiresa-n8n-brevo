-include .env
export

POSTGRES_USER ?= n8n
POSTGRES_DB ?= n8n
BACKUP_FILE ?= backup_$(shell date +%Y%m%d_%H%M%S).sql

.DEFAULT_GOAL := help

.PHONY: help up down reset ps logs shell psql \
	import run-generate run-import test \
	db-backup db-restore workflows-backup

help: ## Affiche cette aide
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

up: ## Demarre n8n + Postgres
	docker compose up -d

down: ## Arrete les conteneurs (garde les donnees)
	docker compose down

reset: ## Arrete et SUPPRIME les volumes (repart de zero) -- destructif
	docker compose down -v

ps: ## Statut des conteneurs
	docker compose ps

logs: ## Suit les logs de n8n
	docker compose logs -f n8n

shell: ## Ouvre un shell dans le conteneur n8n
	docker compose exec n8n sh

psql: ## Ouvre un client psql sur la base n8n
	docker compose exec postgres psql -U $(POSTGRES_USER) -d $(POSTGRES_DB)

import: ## Importe/met a jour les workflows depuis workflows/*.json
	docker compose exec n8n n8n import:workflow --separate --input=/workflows/

run-generate: ## Etape 1: genere brevo_import.csv / non_categorise.csv / a_verifier.csv
	docker compose run --rm n8n execute --id=seg0000001brevo

run-import: ## Etape 2: envoie brevo_import.csv vers l'API Brevo
	docker compose run --rm n8n execute --id=imp0000002brevo

test: ## Teste le script de segmentation en local (sans Docker) sur les vrais CSV
	node workflows/scripts/test-segmenter.js

db-backup: ## Dump complet de la base Postgres vers $(BACKUP_FILE)
	docker compose exec postgres pg_dump -U $(POSTGRES_USER) $(POSTGRES_DB) > $(BACKUP_FILE)
	@echo "Backup ecrit dans $(BACKUP_FILE)"

db-restore: ## Restaure un dump (usage: make db-restore FILE=backup_xxx.sql)
	@test -n "$(FILE)" || (echo "Usage: make db-restore FILE=backup_xxx.sql" && exit 1)
	cat $(FILE) | docker compose exec -T postgres psql -U $(POSTGRES_USER) -d $(POSTGRES_DB)

workflows-backup: ## Resynchronise workflows/0X-*.json avec l'etat actuel dans n8n (credentials a part)
	docker compose exec n8n n8n export:workflow --id=seg0000001brevo --output=/workflows/.raw-01.json
	docker compose exec n8n n8n export:workflow --id=imp0000002brevo --output=/workflows/.raw-02.json
	python3 workflows/scripts/sync-workflow-export.py workflows/.raw-01.json workflows/01-generer-fichiers-brevo.json
	python3 workflows/scripts/sync-workflow-export.py workflows/.raw-02.json workflows/02-importer-contacts-brevo.json
	rm -f workflows/.raw-01.json workflows/.raw-02.json
	docker compose exec n8n n8n export:credentials --all --output=/workflows/backup-credentials.json
	@echo "Fichiers workflows/0X-*.json resynchronises -- verifie 'git diff workflows/' avant de committer."
