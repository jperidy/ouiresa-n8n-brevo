#!/usr/bin/env python3
# Nettoie un export n8n brut (n8n export:workflow --id=... --output=...) pour
# le ramener au format minimal versionne dans workflows/*.json : ne garde que
# id/name/nodes/connections/settings (l'export brut ajoute des metadonnees
# propres a cette instance n8n : createdAt, versionId, shared, staticData...
# qui n'ont rien a faire dans le repo), et vide les credentials.*.id (l'ID
# credential est propre a chaque instance n8n -- on ne committe que le nom,
# voir README §4, pour permettre un rattachement manuel sur une install neuve).
import json
import sys

KEEP_KEYS = ('id', 'name', 'nodes', 'connections', 'settings')


def clean(raw_path, target_path):
    with open(raw_path, encoding='utf8') as f:
        data = json.load(f)
    wf = data[0] if isinstance(data, list) else data

    cleaned = {k: wf[k] for k in KEEP_KEYS}
    for node in cleaned['nodes']:
        for cred in (node.get('credentials') or {}).values():
            cred['id'] = ''

    with open(target_path, 'w', encoding='utf8') as f:
        json.dump(cleaned, f, indent=2, ensure_ascii=False)
        f.write('\n')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print('Usage: sync-workflow-export.py <export_brut.json> <fichier_cible.json>', file=sys.stderr)
        sys.exit(1)
    clean(sys.argv[1], sys.argv[2])
