"""art.example.com — общий холст с регистрацией и историей «кто что рисовал».

стек: flask + flask-sock (websocket) + sqlite. без внешних зависимостей кроме них,
чтобы влезть в память vps (1.9 гб всего, из них ~540 мегабайт свопа занято).

модель данных:
  users(id, login, phash, salt, role, color, created_at)
  sessions(token, user_id, created_at)
  ops(id, user_id, op, payload, created_at)  — op это то что человек сделал:
      stroke / shape / text / erase / fill / clear, payload хранит координаты.
  растровое изображение не хранится вовсе: холст это список операций,
  каждый клиент перерисовывает их сам. это даёт историю по авторам
  и не требует ни картинок, ни canvas-сервера с бинарным состоянием.

ограничения по размеру: операций не больше OPS_MAX на холст, точка в штрихе не
длиннее PTS_MAX, иначе клиент может забить память сервера.
"""

import hashlib
import hmac
import json
import os
import random
import re
import sqlite3
import string
import time
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory, g
from flask_sock import Sock

BASE = Path(__file__).resolve().parent
DATA = BASE / "data"
DATA.mkdir(exist_ok=True)
DB = DATA / "art.db"

ADMIN_LOGIN = os.environ.get("ART_ADMIN_LOGIN", "admin")
ADMIN_PASS = os.environ.get("ART_ADMIN_PASSWORD", "")

LOGIN_RE = re.compile(r"^[a-zA-Z0-9_]{3,20}$")
PASS_MIN = 6
OPS_MAX = 20000
PTS_MAX = 4000
# 400 операций по 4000 точек в худшем случае упираются примерно в 1.5 МБ json,
# поэтому 2 МБ хватает с запасом, а десятки мегабайт мусора уже не пролезут.
BODY_MAX = 2 * 1024 * 1024
COOKIE = "art_sid"
TTL = 30 * 24 * 3600

COLORS = ["#ff2e9a", "#7c5cff", "#22d3ee", "#34d399", "#fbbf24", "#fb7185",
          "#a3e635", "#60a5fa", "#f472b6", "#facc15", "#2dd4bf", "#c084fc"]

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = BODY_MAX
sock = Sock(app)


@app.errorhandler(413)
def too_big(_e):
    # без этого werkzeug отдаёт свой html-трейсбек на 413, клиенту нужен json
    return jsonify({"error": f"запрос больше {BODY_MAX // (1024 * 1024)} МБ"}), 413


# ── база ────────────────────────────────────────────────────────────────────

def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB, timeout=20)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA journal_mode=WAL")
        g.db.execute("PRAGMA synchronous=NORMAL")
    return g.db


@app.teardown_appcontext
def close_db(_e):
    d = g.pop("db", None)
    if d is not None:
        d.close()


def init_db():
    d = sqlite3.connect(DB)
    d.executescript(
        """
        create table if not exists users(
            id integer primary key autoincrement,
            login text unique not null,
            phash text not null,
            salt text not null,
            role text not null default 'user',
            color text not null,
            created_at integer not null
        );
        create table if not exists sessions(
            token text primary key,
            user_id integer not null,
            created_at integer not null
        );
        create table if not exists ops(
            id integer primary key autoincrement,
            user_id integer not null,
            op text not null,
            payload text not null,
            created_at integer not null
        );
        create index if not exists ops_id on ops(id);
        """
    )
    d.commit()
    if ADMIN_PASS:
        row = d.execute("select id from users where login=?", (ADMIN_LOGIN,)).fetchone()
        if not row:
            d.execute(
                "insert into users(login,phash,salt,role,color,created_at) values(?,?,?,?,?,?)",
                (ADMIN_LOGIN, hashpass(ADMIN_PASS, mksalt()),
                 "", "admin", COLORS[0], int(time.time())),
            )
            d.commit()
    d.close()


# ── пароли ──────────────────────────────────────────────────────────────────

def mksalt():
    return "".join(random.choice(string.hexdigits.lower()) for _ in range(16))


def hashpass(pw, salt):
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 120_000)
    return h.hex()


def check(pw, phash, salt):
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 120_000).hex()
    # сравнение хешей постоянного времени, иначе по времени ответа можно подбирать
    return hmac.compare_digest(h, phash or "")


# ── сессии ──────────────────────────────────────────────────────────────────

def user_from_request():
    tok = request.cookies.get(COOKIE)
    if not tok:
        return None
    d = db()
    row = d.execute(
        "select u.* from sessions s join users u on u.id=s.user_id "
        "where s.token=? and s.created_at>?",
        (tok, int(time.time()) - TTL),
    ).fetchone()
    return row


def login_user(login, pw):
    d = db()
    row = d.execute("select * from users where login=? collate nocase", (login,)).fetchone()
    if not row:
        return None
    if row["salt"] == "":
        # админ из .env: пароль в базе не лежит, сравниваем как есть, но тоже
        # постоянного времени
        ok = (row["login"].lower() == ADMIN_LOGIN.lower() and ADMIN_PASS and
              hmac.compare_digest(pw, ADMIN_PASS))
    else:
        ok = check(pw, row["phash"], row["salt"])
    if not ok:
        return None
    tok = "".join(random.choice(string.hexdigits) for _ in range(48))
    d.execute("insert into sessions(token,user_id,created_at) values(?,?,?)",
              (tok, row["id"], int(time.time())))
    d.commit()
    return tok, row


# ── операции холста ─────────────────────────────────────────────────────────

def norm_op(op, p):
    """жёсткая валидация операции. мусор с клиента обязан отбрасываться, а не 500.

    size приходит в процентах от максимальной толщины кисти (1..100), у ластика
    потолок выше. фигуры и заливки клиент больше не шлёт, поэтому их тут нет:
    обработчик всё равно падал бы на отсутствующих ключах.
    """
    if op not in ("stroke", "text", "erase", "clear"):
        return None
    def num(v):
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        if f != f or f in (float("inf"), float("-inf")):
            return None
        return max(-20000.0, min(20000.0, f))
    def col(v):
        if not isinstance(v, str):
            return "#000000"
        v = v.strip()[:9]
        return v if re.match(r"^#[0-9a-fA-F]{3,8}$", v) else "#000000"
    def txt(v):
        return v[:120] if isinstance(v, str) else ""
    # токен операции, по которому клиент узнаёт своё эхо. сервер его не
    # разбирает и не доверяет, только возвращает как есть.
    def cid(v):
        return v[:64] if isinstance(v, str) else None

    if op == "stroke":
        pts = p.get("pts")
        if not isinstance(pts, list) or not pts or len(pts) > PTS_MAX:
            return None
        clean = []
        for q in pts:
            if isinstance(q, (list, tuple)) and len(q) >= 2:
                x, y = num(q[0]), num(q[1])
                if x is None or y is None:
                    return None
                clean.append([x, y])
        if len(clean) < 1:
            return None
        return {"op": op, "pts": clean, "color": col(p.get("color")),
                "size": max(1.0, min(100.0, num(p.get("size")) or 4.0)),
                "cid": cid(p.get("cid"))}

    if op == "text":
        x, y = num(p.get("x")), num(p.get("y"))
        t = txt(p.get("text"))
        if x is None or y is None or not t.strip():
            return None
        return {"op": op, "x": x, "y": y, "text": t, "color": col(p.get("color")),
                "size": max(6.0, min(160.0, num(p.get("size")) or 24.0)),
                "cid": cid(p.get("cid"))}

    if op == "erase":
        # ластик = кисть со стиранием, поэтому несёт те же pts, что и штрих.
        pts = p.get("pts")
        if not isinstance(pts, list) or not pts or len(pts) > PTS_MAX:
            return None
        clean = []
        for q in pts:
            if isinstance(q, (list, tuple)) and len(q) >= 2:
                x, y = num(q[0]), num(q[1])
                if x is None or y is None:
                    return None
                clean.append([x, y])
        if not clean:
            return None
        return {"op": op, "pts": clean,
                "size": max(1.0, min(400.0, num(p.get("size")) or 40.0)),
                "cid": cid(p.get("cid"))}

    if op == "clear":
        return {"op": op}
    return None


def has_clear(ops):
    """чистка ищется во всём батче, а не в первом элементе.

    раньше смотрели только на clean[0], поэтому батч [{stroke},{clear}] от обычного
    юзера проходил и холст стирался.
    """
    return any(o.get("op") == "clear" for o in ops)


def load_ops(limit=OPS_MAX):
    d = db()
    rows = d.execute(
        "select o.id, o.op, o.payload, o.created_at, u.login, u.color as ucolor "
        "from ops o join users u on u.id=o.user_id order by o.id asc limit ?",
        (limit,)).fetchall()
    out = []
    for r in rows:
        try:
            pl = json.loads(r["payload"])
        except ValueError:
            continue
        out.append({"id": r["id"], "by": r["login"], "ucolor": r["ucolor"],
                    "at": r["created_at"], **pl})
    return out


def ops_count():
    return db().execute("select count(*) c from ops").fetchone()["c"]


def online_users():
    """кто сейчас на холсте: клиенты шлют presence, держим в памяти процесса."""
    seen = {}
    now = time.time()
    for uid, info in PRESENCE.items():
        if now - info["seen"] < 40:
            seen[uid] = info
    for uid in list(PRESENCE):
        if now - PRESENCE[uid]["seen"] >= 40:
            del PRESENCE[uid]
    return list(seen.values())


PRESENCE = {}


def broadcast(msg, skip=None):
    data = json.dumps(msg, ensure_ascii=False)
    dead = []
    for c in list(CLIENTS):
        if c is skip:
            continue
        try:
            c.send(data)
        except Exception:
            dead.append(c)
    for c in dead:
        CLIENTS.discard(c)


CLIENTS = set()

# соответствие user_id → его живые сокеты. нужно чтобы бан обрывал уже открытые
# соединения, а не только блокировал новые handshake.
CLIENTS_BY_UID = {}


def drop_clients(uid, why):
    """разорвать все websocket-соединения пользователя (бан, разлогин)."""
    for c in list(CLIENTS_BY_UID.get(uid, ())):
        try:
            c.send(json.dumps({"t": "err", "error": why}, ensure_ascii=False))
            c.close()
        except Exception:
            # сокет уже мёртв, чистить будем в его собственном finally
            pass
        CLIENTS.discard(c)
    CLIENTS_BY_UID.pop(uid, None)


# ── страницы ────────────────────────────────────────────────────────────────

@app.get("/")
def index():
    return send_from_directory(BASE / "static", "index.html")


@app.get("/static/<path:p>")
def static_files(p):
    return send_from_directory(BASE / "static", p)


@app.get("/api/me")
def me():
    u = user_from_request()
    if not u:
        return jsonify({"user": None})
    return jsonify({"user": {"login": u["login"], "role": u["role"],
                             "color": u["color"], "id": u["id"]}})


@app.post("/api/register")
def register():
    j = request.get_json(silent=True) or {}
    login = str(j.get("login", "")).strip()
    pw = str(j.get("password", ""))
    if not LOGIN_RE.match(login):
        return jsonify({"error": "логин: 3-20 символов, латиница, цифры, _"}), 400
    if len(pw) < PASS_MIN:
        return jsonify({"error": f"пароль минимум {PASS_MIN} символов"}), 400
    d = db()
    if d.execute("select 1 from users where login=? collate nocase", (login,)).fetchone():
        return jsonify({"error": "такой логин уже занят"}), 409
    salt = mksalt()
    color = COLORS[random.randrange(1, len(COLORS))]
    try:
        cur = d.execute(
            "insert into users(login,phash,salt,role,color,created_at) values(?,?,?,?,?,?)",
            (login, hashpass(pw, salt), salt, "user", color, int(time.time())))
        d.commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "такой логин уже занят"}), 409
    tok, row = login_user(login, pw)
    resp = jsonify({"ok": True, "user": {"login": row["login"], "role": row["role"],
                                         "color": row["color"], "id": row["id"]}})
    resp.set_cookie(COOKIE, tok, httponly=True, samesite="Lax", max_age=TTL)
    return resp


@app.post("/api/login")
def do_login():
    j = request.get_json(silent=True) or {}
    login = str(j.get("login", "")).strip()
    pw = str(j.get("password", ""))
    r = login_user(login, pw)
    if not r:
        return jsonify({"error": "неверный логин или пароль"}), 401
    tok, row = r
    resp = jsonify({"ok": True, "user": {"login": row["login"], "role": row["role"],
                                         "color": row["color"], "id": row["id"]}})
    resp.set_cookie(COOKIE, tok, httponly=True, samesite="Lax", max_age=TTL)
    return resp


@app.post("/api/logout")
def do_logout():
    tok = request.cookies.get(COOKIE)
    if tok:
        d = db()
        d.execute("delete from sessions where token=?", (tok,))
        d.commit()
    resp = jsonify({"ok": True})
    resp.delete_cookie(COOKIE)
    return resp


@app.get("/api/board")
def board():
    u = user_from_request()
    if not u:
        return jsonify({"error": "нужен вход"}), 401
    return jsonify({"ops": load_ops(), "online": online_users(),
                    "count": ops_count()})


@app.post("/api/ops")
def push_ops():
    u = user_from_request()
    if not u:
        return jsonify({"error": "нужен вход"}), 401
    j = request.get_json(silent=True) or {}
    items = j.get("ops")
    if not isinstance(items, list) or not items or len(items) > 400:
        return jsonify({"error": "плохой payload"}), 400
    clean = [o for o in (norm_op(x.get("op"), x) for x in items if isinstance(x, dict)) if o]
    if not clean:
        return jsonify({"error": "ничего не принято"}), 400
    d = db()
    clear = has_clear(clean)
    if clear and u["role"] != "admin":
        return jsonify({"error": "чистить холст может только админ"}), 403
    now = int(time.time())
    ids = []
    for o in clean:
        cur = d.execute("insert into ops(user_id,op,payload,created_at) values(?,?,?,?)",
                        (u["id"], o["op"], json.dumps(o, ensure_ascii=False), now))
        ids.append(cur.lastrowid)
    if clear:
        d.execute("delete from ops")
        d.commit()
    else:
        # подрезаем историю, чтобы база не росла бесконечно
        d.execute(
            "delete from ops where id <= (select max(id)-? from ops)", (OPS_MAX,))
        d.commit()
    saved = []
    for oid, o in zip(ids, clean):
        saved.append({"id": oid, "by": u["login"], "ucolor": u["color"],
                      "at": now, **o})
    broadcast({"t": "ops", "ops": saved})
    return jsonify({"ok": True, "ops": saved})


@app.post("/api/undo")
def undo():
    """отмена последнего штриха пользователя. сервер удаляет запись и говорит всем."""
    u = user_from_request()
    if not u:
        return jsonify({"error": "нужен вход"}), 401
    d = db()
    row = d.execute(
        "select id from ops where user_id=? order by id desc limit 1", (u["id"],)).fetchone()
    if not row:
        return jsonify({"error": "нечего отменять"}), 400
    d.execute("delete from ops where id=?", (row["id"],))
    d.commit()
    broadcast({"t": "undo", "id": row["id"], "by": u["login"]})
    return jsonify({"ok": True, "id": row["id"]})


@app.get("/api/history")
def history():
    """лента «кто что рисовал»: последние операции с автором."""
    u = user_from_request()
    if not u:
        return jsonify({"error": "нужен вход"}), 401
    d = db()
    try:
        n = max(1, min(300, int(request.args.get("n", 120))))
    except (TypeError, ValueError):
        # мусорный ?n= должен давать дефолт, а не 500
        n = 120
    rows = d.execute(
        "select o.id,o.op,o.payload,o.created_at,u.login,u.color as ucolor "
        "from ops o join users u on u.id=o.user_id "
        "order by o.id desc limit ?", (n,)).fetchall()
    out = []
    for r in reversed(rows):
        try:
            full = json.loads(r["payload"])
        except ValueError:
            continue
        # pts выкидываем — история показывает только автора и что он делал.
        # pts_count считаем по исходному payload, а не по обрезанному.
        pts = full.get("pts")
        pl = {k: v for k, v in full.items() if k != "pts"}
        if isinstance(pts, list):
            pl["pts_count"] = len(pts)
        out.append({"id": r["id"], "by": r["login"], "ucolor": r["ucolor"],
                    "at": r["created_at"], **pl})
    return jsonify({"history": out})


@app.get("/api/users")
def users_list():
    u = user_from_request()
    if not u:
        return jsonify({"error": "нужен вход"}), 401
    d = db()
    rows = d.execute(
        "select u.id,u.login,u.color,u.role,u.created_at,"
        "(select count(*) from ops o where o.user_id=u.id) as ops "
        "from users u order by ops desc, u.id asc limit 200").fetchall()
    return jsonify({"users": [dict(r) for r in rows], "online": online_users()})


@app.post("/api/admin/clear")
def admin_clear():
    u = user_from_request()
    if not u or u["role"] != "admin":
        return jsonify({"error": "только админ"}), 403
    d = db()
    d.execute("delete from ops")
    d.commit()
    broadcast({"t": "reload"})
    return jsonify({"ok": True})


@app.post("/api/admin/undo_by")
def admin_undo_by():
    """снять конкретную операцию по id (админская чистка отдельного штриха)."""
    u = user_from_request()
    if not u or u["role"] != "admin":
        return jsonify({"error": "только админ"}), 403
    j = request.get_json(silent=True) or {}
    try:
        oid = int(j.get("id"))
    except (TypeError, ValueError):
        return jsonify({"error": "плохой id"}), 400
    d = db()
    d.execute("delete from ops where id=?", (oid,))
    d.commit()
    broadcast({"t": "undo", "id": oid, "by": u["login"]})
    return jsonify({"ok": True})


@app.post("/api/admin/user")
def admin_user():
    """снять все операции пользователя или забанить логин."""
    u = user_from_request()
    if not u or u["role"] != "admin":
        return jsonify({"error": "только админ"}), 403
    j = request.get_json(silent=True) or {}
    action = j.get("action")
    target = str(j.get("login", ""))
    if action not in ("wipe", "ban", "unban"):
        return jsonify({"error": "плохое действие"}), 400
    d = db()
    row = d.execute("select * from users where login=? collate nocase", (target,)).fetchone()
    if not row:
        return jsonify({"error": "нет такого юзера"}), 404
    if row["role"] == "admin":
        return jsonify({"error": "с админом так не делают"}), 403
    if action == "wipe":
        d.execute("delete from ops where user_id=?", (row["id"],))
        d.commit()
        broadcast({"t": "reload"})
        return jsonify({"ok": True})
    if action == "ban":
        # соль 'banned' и пустой хеш — это и есть признак бана: логин больше не
        # проходит check(), потому что хеш не сойдётся никогда
        d.execute("update users set phash='', salt='banned' where id=?", (row["id"],))
        d.execute("delete from sessions where user_id=?", (row["id"],))
        d.commit()
        # живые websocket-соединения проверяют бан только в цикле приёма, поэтому
        # рвём их сразу, иначе забаненный дошлёт операции до конца таймаута
        drop_clients(row["id"], "бан")
        return jsonify({"ok": True, "banned": True})
    # unban: пароль сбрасывается на 123456, соль и хеш обязаны считаться от
    # одной и той же соли, иначе пароль не подойдёт никогда
    salt = mksalt()
    d.execute("update users set salt=?, phash=? where id=?",
              (salt, hashpass("123456", salt), row["id"]))
    d.execute("delete from sessions where user_id=?", (row["id"],))
    d.commit()
    return jsonify({"ok": True, "unbanned": True})


# ── websocket ───────────────────────────────────────────────────────────────

@sock.route("/ws")
def ws(ws):
    # ВАЖНО: у flask-sock объект Server не имеет .request/.headers — они есть
    # только в WSGI-окружении request. Раньше здесь стояло ws.request.headers и
    # соединение падало с AttributeError на КАЖДОМ handshake.
    hdrs = request.headers
    tok = None
    for part in (hdrs.get("Cookie") or "").split(";"):
        if part.strip().startswith(COOKIE + "="):
            tok = part.strip().split("=", 1)[1]
    if not tok:
        ws.send(json.dumps({"t": "err", "error": "нет сессии"}))
        return
    d = sqlite3.connect(DB, timeout=20)
    d.row_factory = sqlite3.Row
    u = d.execute(
        "select u.* from sessions s join users u on u.id=s.user_id "
        "where s.token=? and s.created_at>?", (tok, int(time.time()) - TTL)).fetchone()
    if not u:
        d.close()
        ws.send(json.dumps({"t": "err", "error": "сессия истекла"}))
        return
    uid = u["id"]
    PRESENCE[uid] = {"login": u["login"], "color": u["color"], "seen": time.time()}
    CLIENTS.add(ws)
    CLIENTS_BY_UID.setdefault(uid, set()).add(ws)
    # соединение считается рабочим, пока сессия жива в базе: бан удаляет сессии,
    # поэтому проверка в цикле ловит бан без всякого второго канала
    def alive():
        return d.execute("select 1 from sessions where token=?",
                         (tok,)).fetchone() is not None
    ws.send(json.dumps({"t": "hello", "login": u["login"], "color": u["color"],
                        "role": u["role"]}))
    broadcast({"t": "presence", "online": online_users()})
    last_beat = 0.0
    # счётчик тишины. simple_websocket.receive(timeout=25) возвращает None и
    # на таймауте, и когда данных просто нет — из этого нельзя отличить
    # «клиент жив и молчит» от «клиент исчез, но сокет не закрыт». раньше
    # цикл на None делал continue и не выходил НИКОГДА: соединение жило вечно,
    # finally не выполнялся, PRESENCE не чистился, юзер навсегда «онлайн».
    # клиент шлёт ping каждые 15с, поэтому 8 тихих окон по 25с (200с) это
    # гарантированно мёртвое соединение.
    silent = 0
    try:
        while True:
            raw = ws.receive(timeout=25)
            # сессию могли снести пока сокет был открыт (бан/логаут): без этой
            # проверки забаненный слал бы операции до конца таймаута
            if not alive():
                break
            if raw is None:
                silent += 1
                if silent >= 8:
                    break
                PRESENCE[uid]["seen"] = time.time()
                now = time.time()
                if now - last_beat > 10:
                    broadcast({"t": "presence", "online": online_users()})
                    last_beat = now
                continue
            silent = 0
            try:
                m = json.loads(raw)
            except ValueError:
                continue
            PRESENCE[uid]["seen"] = time.time()
            if not isinstance(m, dict):
                continue
            t = m.get("t")
            if t == "pong" or t == "ping":
                # ping шлёт клиент каждые 15с: он сбрасывает счётчик тишины
                # и доказывает серверу что сокет живой. ответ не нужен —
                # presence уже рассылается по своему таймеру
                continue
            if t == "cursor":
                PRESENCE[uid].update({"x": m.get("x"), "y": m.get("y")})
                broadcast({"t": "cursor", "login": u["login"], "color": u["color"],
                           "x": m.get("x"), "y": m.get("y")}, skip=ws)
                continue
            if t == "ops":
                items = m.get("ops")
                if not isinstance(items, list) or not items or len(items) > 400:
                    continue
                clean = [o for o in
                         (norm_op(x.get("op"), x) for x in items if isinstance(x, dict))
                         if o]
                if not clean:
                    continue
                clear = has_clear(clean)
                if clear and u["role"] != "admin":
                    continue
                now = int(time.time())
                ids = []
                for o in clean:
                    cur = d.execute(
                        "insert into ops(user_id,op,payload,created_at) values(?,?,?,?)",
                        (uid, o["op"], json.dumps(o, ensure_ascii=False), now))
                    ids.append(cur.lastrowid)
                if clear:
                    d.execute("delete from ops")
                else:
                    d.execute(
                        "delete from ops where id <= (select max(id)-? from ops)",
                        (OPS_MAX,))
                d.commit()
                saved = [{"id": oid, "by": u["login"], "ucolor": u["color"],
                          "at": now, **o} for oid, o in zip(ids, clean)]
                broadcast({"t": "ops", "ops": saved})
                continue
            if t == "undo":
                row = d.execute("select id from ops where user_id=? order by id desc limit 1",
                                (uid,)).fetchone()
                if row:
                    d.execute("delete from ops where id=?", (row["id"],))
                    d.commit()
                    broadcast({"t": "undo", "id": row["id"], "by": u["login"]})
    except Exception:
        pass
    finally:
        CLIENTS.discard(ws)
        mine = CLIENTS_BY_UID.get(uid)
        if mine is not None:
            mine.discard(ws)
            if not mine:
                CLIENTS_BY_UID.pop(uid, None)
        PRESENCE.pop(uid, None)
        broadcast({"t": "presence", "online": online_users()})
        d.close()


init_db()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8110, threaded=True)