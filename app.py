import hmac
import math
import os
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, request, session
from supabase import Client, create_client

load_dotenv()

APP_PASSWORD = os.environ.get("APP_PASSWORD")
SESSION_SECRET = os.environ.get("SESSION_SECRET")
if not APP_PASSWORD or not SESSION_SECRET:
    raise SystemExit("APP_PASSWORD and SESSION_SECRET must both be set in .env before starting.")

app = Flask(__name__, static_folder="public", static_url_path="")
app.secret_key = SESSION_SECRET
app.permanent_session_lifetime = timedelta(days=30)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("ENV") == "production",
)

supabase: Client = create_client(
    os.environ["SUPABASE_URL"],
    os.environ["SUPABASE_SECRET_KEY"],  # service/secret key — bypasses RLS, server-side only
)

CATEGORIES = ["Tablet", "Syrup", "Ointment", "Other"]


def error_message(exc):
    return getattr(exc, "message", None) or str(exc)


def to_number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def round_rupees(x):
    # Math.round-equivalent (round-half-up) for positive rupee amounts.
    return math.floor(x * 100 + 0.5) / 100


# ---------- Auth (single shared shop password, no per-user accounts) ----------

PUBLIC_PATHS = {"/login.html", "/api/login"}


@app.before_request
def require_auth():
    if request.path in PUBLIC_PATHS or session.get("authed"):
        return None
    if request.path.startswith("/api/"):
        return jsonify(error="Not authenticated"), 401
    return redirect("/login.html")


@app.post("/api/login")
def login():
    body = request.get_json(silent=True) or {}
    given = body.get("password") or ""
    if not hmac.compare_digest(APP_PASSWORD, given):
        return jsonify(error="Wrong password"), 401
    session.permanent = True
    session["authed"] = True
    return jsonify(ok=True)


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/")
def index():
    return app.send_static_file("index.html")


# ---------- Products ----------


@app.get("/api/products/search")
def search_products():
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify([])
    try:
        res = (
            supabase.table("product_summary")
            .select("*")
            .ilike("name", f"%{q}%")
            .order("name")
            .limit(10)
            .execute()
        )
    except Exception as e:
        return jsonify(error=error_message(e)), 500
    return jsonify([{**p, "low_stock": p["stock_qty"] < p["low_stock_threshold"]} for p in res.data])


@app.get("/api/products")
def list_products():
    try:
        res = supabase.table("product_summary").select("*").order("name").execute()
    except Exception as e:
        return jsonify(error=error_message(e)), 500
    return jsonify([{**p, "low_stock": p["stock_qty"] < p["low_stock_threshold"]} for p in res.data])


@app.post("/api/products")
def create_product():
    body = request.get_json(silent=True) or {}
    name = body.get("name")
    category = body.get("category")
    if not name:
        return jsonify(error="name is required"), 400
    if category and category not in CATEGORIES:
        return jsonify(error=f"category must be one of {', '.join(CATEGORIES)}"), 400
    try:
        res = (
            supabase.table("products")
            .insert(
                {
                    "name": name,
                    "category": category or "Other",
                    "manufacturer": body.get("manufacturer") or None,
                    "prescription_required": bool(body.get("prescription_required")),
                    "rack_location": (body.get("rack_location") or "").strip() or None,
                    "low_stock_threshold": body.get("low_stock_threshold") or 10,
                }
            )
            .execute()
        )
    except Exception as e:
        return jsonify(error=error_message(e)), 500
    return jsonify(res.data[0]), 201


@app.patch("/api/products/<int:product_id>")
def update_product(product_id):
    body = request.get_json(silent=True) or {}
    category = body.get("category")
    if category and category not in CATEGORIES:
        return jsonify(error=f"category must be one of {', '.join(CATEGORIES)}"), 400

    updates = {"updated_at": datetime.now(timezone.utc).isoformat()}
    for field in (
        "name",
        "category",
        "manufacturer",
        "low_stock_threshold",
        "prescription_required",
        "rack_location",
    ):
        if body.get(field) is not None:
            updates[field] = body[field]

    try:
        res = supabase.table("products").update(updates).eq("id", product_id).execute()
    except Exception as e:
        return jsonify(error=error_message(e)), 500
    return jsonify(res.data[0])


# ---------- Dealers ----------


@app.get("/api/dealers")
def list_dealers():
    try:
        res = supabase.table("dealers").select("*").order("name").execute()
    except Exception as e:
        return jsonify(error=error_message(e)), 500
    return jsonify(res.data)


@app.post("/api/dealers")
def create_dealer():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify(error="name is required"), 400
    try:
        res = (
            supabase.table("dealers")
            .insert(
                {
                    "name": name,
                    "phone": body.get("phone") or None,
                    "address": body.get("address") or None,
                    "gstin": body.get("gstin") or None,
                    "notes": body.get("notes") or None,
                }
            )
            .execute()
        )
    except Exception as e:
        return jsonify(error=error_message(e)), 500
    return jsonify(res.data[0]), 201


@app.patch("/api/dealers/<int:dealer_id>")
def update_dealer(dealer_id):
    body = request.get_json(silent=True) or {}
    updates = {}
    for field in ("name", "phone", "address", "gstin", "notes"):
        if body.get(field) is not None:
            updates[field] = body[field]
    try:
        res = supabase.table("dealers").update(updates).eq("id", dealer_id).execute()
    except Exception as e:
        return jsonify(error=error_message(e)), 500
    return jsonify(res.data[0])


# ---------- Batches (stock-in) ----------


@app.get("/api/products/<int:product_id>/batches")
def list_batches(product_id):
    try:
        res = (
            supabase.table("batches")
            .select("*, dealers(name)")
            .eq("product_id", product_id)
            .gt("qty_remaining", 0)
            .order("expiry_date", desc=False)
            .order("received_at", desc=False)
            .execute()
        )
    except Exception as e:
        return jsonify(error=error_message(e)), 500
    data = []
    for row in res.data:
        dealer = row.pop("dealers", None)
        row["dealer_name"] = dealer["name"] if dealer else None
        data.append(row)
    return jsonify(data)


@app.post("/api/products/<int:product_id>/batches")
def add_batch(product_id):
    body = request.get_json(silent=True) or {}
    qty = body.get("qty")
    dealer_id = body.get("dealer_id")
    expiry_date = body.get("expiry_date")

    if not dealer_id:
        return jsonify(error="dealer is required"), 400
    if not expiry_date:
        return jsonify(error="expiry_date is required"), 400

    size = int(to_number(body.get("pack_size")) or 1)
    mrp_amount = to_number(body.get("mrp_amount"))
    cost_amount = to_number(body.get("cost_amount"))
    if not mrp_amount or mrp_amount <= 0:
        return jsonify(error="mrp_amount must be a positive number"), 400
    if not cost_amount or cost_amount <= 0:
        return jsonify(error="cost_amount must be a positive number"), 400
    if not qty or qty <= 0:
        return jsonify(error="qty must be a positive number"), 400

    is_paise = body.get("price_unit") == "paise"
    mrp_pack_price = mrp_amount / 100 if is_paise else mrp_amount
    cost_pack_price = cost_amount / 100 if is_paise else cost_amount

    try:
        res = (
            supabase.table("batches")
            .insert(
                {
                    "product_id": product_id,
                    "dealer_id": dealer_id,
                    "batch_number": body.get("batch_number") or None,
                    "pack_size": size,
                    "mrp_pack_price": mrp_pack_price,
                    "mrp_unit_price": round_rupees(mrp_pack_price / size),
                    "cost_pack_price": cost_pack_price,
                    "cost_unit_price": round_rupees(cost_pack_price / size),
                    "qty_received": qty,
                    "qty_remaining": qty,
                    "expiry_date": expiry_date,
                }
            )
            .execute()
        )
    except Exception as e:
        return jsonify(error=error_message(e)), 500
    return jsonify(res.data[0]), 201


# ---------- Sales ----------


@app.post("/api/sales")
def create_sale():
    body = request.get_json(silent=True) or {}
    items = body.get("items")
    if not isinstance(items, list) or len(items) == 0:
        return jsonify(error="items array is required"), 400
    try:
        res = supabase.rpc("checkout_sale", {"p_items": items}).execute()
    except Exception as e:
        return jsonify(error=error_message(e)), 400
    return jsonify(res.data), 201


@app.get("/api/sales")
def sales_history():
    try:
        sales = supabase.table("sales").select("*").order("created_at", desc=True).limit(100).execute().data
    except Exception as e:
        return jsonify(error=error_message(e)), 500
    if not sales:
        return jsonify([])
    ids = [s["id"] for s in sales]
    try:
        items = supabase.table("sale_items").select("*").in_("sale_id", ids).execute().data
    except Exception as e:
        return jsonify(error=error_message(e)), 500
    return jsonify([{**s, "items": [i for i in items if i["sale_id"] == s["id"]]} for s in sales])


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3000))
    app.run(host="0.0.0.0", port=port)
