#!/usr/bin/env bash
# Sets up (if needed) and starts the app locally: venv -> deps -> python app.py
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -d .venv ]; then
  echo "Creating virtualenv in .venv/ ..."
  python3 -m venv .venv
fi

source .venv/bin/activate
pip install -q -r requirements.txt

if [ ! -f .env ]; then
  echo "No .env found — copy .env.example to .env and fill in SUPABASE_URL, SUPABASE_SECRET_KEY, APP_PASSWORD, SESSION_SECRET first."
  exit 1
fi

python app.py
