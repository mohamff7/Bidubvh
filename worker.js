// متجر اشتراكات — ملف واحد لـ Cloudflare Workers (يضم السيرفر والواجهة).
import { DurableObject } from 'cloudflare:workers';

/* ───────── بيانات المنتجات الأولية ───────── */
// بيانات تجريبية: عدّل الأسماء والأسعار (بالسنت) كما تريد، أو احذف data/store.db ليُعاد التحميل.
// manual: 1 = التسليم يدوي من المشرف عند نفاد المخزون، 0 = لا تُباع إلا إذا توفّر مخزون.

const CATEGORIES = [
  { key: 'video', name: 'مشاهدة' },
  { key: 'music', name: 'موسيقى' },
  { key: 'ai', name: 'ذكاء اصطناعي' },
  { key: 'games', name: 'ألعاب' },
  { key: 'apps', name: 'تصميم وتواصل' },
];

const PRODUCTS = [
  {
    name: 'Netflix', cat: 'video', color: '#F0525C', glyph: 'N',
    desc: 'أفلام ومسلسلات وأعمال أصلية',
    plans: [
      { label: 'شهر واحد', price: 600, manual: 1 },
      { label: '3 أشهر', price: 1700, manual: 1 },
    ],
  },
  {
    name: 'Shahid', cat: 'video', color: '#F5C542', glyph: 'ش',
    desc: 'مسلسلات وأفلام عربية وعالمية',
    plans: [
      { label: 'شهر واحد', price: 600, manual: 1 },
      { label: '3 أشهر', price: 1600, manual: 1 },
    ],
  },
  {
    name: 'Disney+', cat: 'video', color: '#3E7BFA', glyph: 'D+',
    desc: 'أفلام عائلية وسلاسل شهيرة',
    plans: [
      { label: 'شهر واحد', price: 500, manual: 1 },
      { label: 'سنة كاملة', price: 4500, manual: 1 },
    ],
  },
  {
    name: 'YouTube Premium', cat: 'video', color: '#FF8A3D', glyph: 'Y',
    desc: 'يوتيوب بدون إعلانات مع تشغيل في الخلفية',
    plans: [
      { label: 'شهر واحد', price: 400, manual: 1 },
      { label: '3 أشهر', price: 1100, manual: 1 },
    ],
  },
  {
    name: 'Spotify Premium', cat: 'music', color: '#35D07F', glyph: 'S',
    desc: 'موسيقى بدون إعلانات وتحميل للاستماع دون إنترنت',
    plans: [
      { label: 'شهر واحد', price: 500, manual: 1 },
      { label: '3 أشهر', price: 1300, manual: 1 },
      { label: 'سنة كاملة', price: 4800, manual: 1 },
    ],
  },
  {
    name: 'ChatGPT Plus', cat: 'ai', color: '#7C6CFF', glyph: 'G',
    desc: 'مساعد ذكاء اصطناعي بميزات متقدمة',
    plans: [{ label: 'شهر واحد', price: 2000, manual: 1 }],
  },
  {
    name: 'PlayStation Plus', cat: 'games', color: '#E6E9F5', glyph: 'P+',
    desc: 'ألعاب شهرية ولعب أونلاين',
    plans: [
      { label: 'شهر واحد', price: 900, manual: 1 },
      { label: '3 أشهر', price: 2500, manual: 1 },
    ],
  },
  {
    name: 'Canva Pro', cat: 'apps', color: '#22C7E8', glyph: 'Ca',
    desc: 'تصميم بقوالب وأدوات متقدمة',
    plans: [
      { label: 'شهر واحد', price: 300, manual: 1 },
      { label: 'سنة كاملة', price: 2500, manual: 1 },
    ],
  },
  {
    name: 'Discord Nitro', cat: 'apps', color: '#FF7AB6', glyph: 'Dc',
    desc: 'ميزات متقدمة للخوادم والملف الشخصي',
    plans: [{ label: 'شهر واحد', price: 800, manual: 1 }],
  },
];

/* ───────── منطق المتجر (Durable Object) ───────── */

const TOPUPS = [5, 10, 25, 50]; // باقات الشحن بالدولار
const enc = new TextEncoder();
const WEB_BASE = 1_000_000_000_000; // معرّفات حسابات الموقع تبدأ من هنا حتى لا تتعارض مع معرّفات تيليجرام
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256hex = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const safeEqual = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
async function pbkdf2(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const now = () => Math.floor(Date.now() / 1000);
const usd = (c) => `$${(c / 100).toFixed(2)}`;
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/* ───────── التحقق من هوية تيليجرام (WebCrypto) ───────── */
async function hmacSign(keyBytes, dataBytes) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, dataBytes));
}

async function verifyInitData(raw, token) {
  const p = new URLSearchParams(raw);
  const hash = p.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  p.delete('hash');
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmacSign(enc.encode('WebAppData'), enc.encode(token));
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sig = Uint8Array.from(hash.match(/../g).map((h) => parseInt(h, 16)));
  if (!(await crypto.subtle.verify('HMAC', key, sig, enc.encode(check)))) return null; // مقارنة ثابتة الزمن
  if (now() - Number(p.get('auth_date')) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.token = env.BOT_TOKEN || '';
    this.dev = env.DEV === '1';
    this.rate = Number(env.STARS_PER_USD || 50);
    this.admins = String(env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
    this.support = String(env.SUPPORT_USERNAME || '').replace('@', '');
    this.sifaloUser = env.SIFALO_API_USER || '';
    this.sifaloKey = env.SIFALO_API_KEY || '';
    this.sifalo = !!(this.sifaloUser && this.sifaloKey);
    this.staging = env.SIFALO_ENV === 'staging';
    this.adminPassword = env.ADMIN_PASSWORD || '';
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  /* ───────── قاعدة البيانات ───────── */
  all(sql, ...p) { return this.sql.exec(sql, ...p).toArray(); }
  get(sql, ...p) { return this.all(sql, ...p)[0] ?? null; }
  run(sql, ...p) { return this.all(sql, ...p); } // استخدم RETURNING لمعرفة هل تغيّر شيء
  tx(fn) { return this.ctx.storage.transactionSync(fn); }

  migrate() {
    const stmts = [
      'CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT, username TEXT, balance INTEGER NOT NULL DEFAULT 0, created INTEGER)',
      'CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, name TEXT, cat TEXT, color TEXT, glyph TEXT, descr TEXT, sort INTEGER DEFAULT 0, active INTEGER DEFAULT 1)',
      'CREATE TABLE IF NOT EXISTS plans(id INTEGER PRIMARY KEY, product_id INTEGER, label TEXT, price INTEGER, manual INTEGER DEFAULT 1, active INTEGER DEFAULT 1)',
      'CREATE TABLE IF NOT EXISTS stock(id INTEGER PRIMARY KEY, plan_id INTEGER, content TEXT, order_id INTEGER)',
      'CREATE INDEX IF NOT EXISTS stock_free ON stock(plan_id, order_id)',
      'CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, user_id INTEGER, plan_id INTEGER, price INTEGER, stars INTEGER, method TEXT, status TEXT, delivery TEXT, created INTEGER, updated INTEGER)',
      'CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY, user_id INTEGER, delta INTEGER, note TEXT, created INTEGER)',
      'CREATE TABLE IF NOT EXISTS web_accounts(email TEXT PRIMARY KEY, user_id INTEGER UNIQUE, salt TEXT, hash TEXT, created INTEGER)',
      'CREATE TABLE IF NOT EXISTS web_sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER, expires INTEGER)',
      'CREATE TABLE IF NOT EXISTS login_fail(email TEXT PRIMARY KEY, n INTEGER, until INTEGER)',
      'CREATE TABLE IF NOT EXISTS topups(ref TEXT PRIMARY KEY, user_id INTEGER, cents INTEGER, gw_key TEXT, sid TEXT, status TEXT, checked INTEGER DEFAULT 0, created INTEGER)',
      'CREATE UNIQUE INDEX IF NOT EXISTS topups_sid ON topups(sid) WHERE sid IS NOT NULL',
      'CREATE TABLE IF NOT EXISTS media(id INTEGER PRIMARY KEY, mime TEXT, data TEXT, created INTEGER)',
      'CREATE TABLE IF NOT EXISTS banners(id INTEGER PRIMARY KEY, media_id INTEGER, link TEXT, sort INTEGER DEFAULT 0, active INTEGER DEFAULT 1)',
      'CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)',
      'CREATE TABLE IF NOT EXISTS payments(charge_id TEXT PRIMARY KEY, user_id INTEGER, payload TEXT, stars INTEGER, created INTEGER)',
    ];
    for (const s of stmts) this.run(s);
    for (const a of ['ALTER TABLE products ADD COLUMN image INTEGER', 'ALTER TABLE topups ADD COLUMN plans TEXT', 'ALTER TABLE topups ADD COLUMN result TEXT']) {
      try { this.run(a); } catch { /* العمود موجود */ }
    }
    if (!this.get('SELECT COUNT(*) AS n FROM products').n) {
      PRODUCTS.forEach((p, i) => {
        const r = this.get('INSERT INTO products(name,cat,color,glyph,descr,sort) VALUES (?,?,?,?,?,?) RETURNING id', p.name, p.cat, p.color, p.glyph, p.desc, i);
        for (const pl of p.plans) this.run('INSERT INTO plans(product_id,label,price,manual) VALUES (?,?,?,?)', r.id, pl.label, pl.price, pl.manual);
      });
    }
  }

  starsFor(cents) { return Math.ceil((cents * this.rate) / 100); }
  centsFor(stars) { return Math.floor((stars * 100) / this.rate); }

  /* ───────── تيليجرام ───────── */
  async tg(method, body = {}) {
    if (!this.token) throw new Error('BOT_TOKEN غير مضبوط');
    const r = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(`${method}: ${j.description}`);
    return j.result;
  }
  say(chat_id, text, extra = {}) {
    if (!this.token || chat_id >= WEB_BASE) return null;
    return this.tg('sendMessage', { chat_id, text, parse_mode: 'HTML', ...extra }).catch((e) => console.error(e.message));
  }
  tellAdmins(text) { return Promise.all(this.admins.map((id) => this.say(id, text))); }

  /* ───────── المستخدمون والرصيد ───────── */
  upsertUser(u) {
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'مستخدم';
    this.run(`INSERT INTO users(id,name,username,created) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, username=excluded.username`, u.id, name, u.username ?? null, now());
    return this.get('SELECT * FROM users WHERE id=?', u.id);
  }
  addBalance(userId, delta, note) {
    this.run('UPDATE users SET balance=balance+? WHERE id=?', delta, userId);
    this.run('INSERT INTO ledger(user_id,delta,note,created) VALUES (?,?,?,?)', userId, delta, note, now());
  }

  async auth(request) {
    const raw = request.headers.get('x-init-data');
    if (raw) {
      const u = await verifyInitData(raw, this.token);
      if (u) return this.upsertUser(u);
      throw httpErr(401, 'انتهت الجلسة. أغلق المتجر وافتحه من جديد');
    }
    const bearer = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('authorization') || '');
    if (bearer) {
      const row = this.get('SELECT user_id FROM web_sessions WHERE token_hash=? AND expires>?', await sha256hex(bearer[1]), now());
      if (row && row.user_id > 0) return this.get('SELECT * FROM users WHERE id=?', row.user_id);
    }
    if (this.dev && !bearer) return this.upsertUser({ id: 1, first_name: 'مستخدم', last_name: 'تجريبي', username: 'dev' });
    throw httpErr(401, 'سجّل الدخول للمتابعة');
  }

  /* ───────── حسابات الموقع ───────── */
  async newSession(userId, ttl = 30 * 86400) {
    const token = randHex(32);
    this.run('DELETE FROM web_sessions WHERE expires<?', now());
    this.run('INSERT INTO web_sessions(token_hash,user_id,expires) VALUES (?,?,?)', await sha256hex(token), userId, now() + ttl);
    return token;
  }

  async signup({ email, password, name }) {
    email = String(email || '').trim().toLowerCase();
    password = String(password || '');
    name = String(name || '').trim().slice(0, 40) || email.split('@')[0];
    if (!EMAIL_RE.test(email) || email.length > 120) throw httpErr(400, 'اكتب بريدًا إلكترونيًا صحيحًا');
    if (password.length < 8 || password.length > 100) throw httpErr(400, 'كلمة المرور من 8 إلى 100 حرف');
    if (this.get('SELECT 1 AS x FROM web_accounts WHERE email=?', email)) throw httpErr(409, 'هذا البريد مسجّل من قبل. سجّل الدخول');
    const salt = randHex(16);
    const hash = await pbkdf2(password, salt);
    const userId = this.tx(() => {
      const id = this.get('SELECT COALESCE(MAX(id), ?) + 1 AS n FROM users WHERE id>=?', WEB_BASE, WEB_BASE).n;
      this.run('INSERT INTO users(id,name,username,created) VALUES (?,?,?,?)', id, name, null, now());
      this.run('INSERT INTO web_accounts(email,user_id,salt,hash,created) VALUES (?,?,?,?,?)', email, id, salt, hash, now());
      return id;
    });
    return { token: await this.newSession(userId) };
  }

  async login({ email, password }) {
    email = String(email || '').trim().toLowerCase();
    password = String(password || '');
    const f = this.get('SELECT * FROM login_fail WHERE email=?', email);
    if (f && f.until > now()) throw httpErr(429, 'محاولات كثيرة. حاول بعد 15 دقيقة');
    const acc = this.get('SELECT * FROM web_accounts WHERE email=?', email);
    // نحسب الاشتقاق حتى لو الحساب غير موجود، لتتساوى أزمنة الاستجابة
    const calc = await pbkdf2(password.slice(0, 100), acc ? acc.salt : '00'.repeat(16));
    if (!acc || !safeEqual(calc, acc.hash)) {
      const n = (f?.n || 0) + 1;
      this.run('INSERT INTO login_fail(email,n,until) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET n=excluded.n, until=excluded.until',
        email.slice(0, 120), n >= 5 ? 0 : n, n >= 5 ? now() + 900 : 0);
      throw httpErr(401, 'البريد أو كلمة المرور غير صحيحة');
    }
    this.run('DELETE FROM login_fail WHERE email=?', email);
    return { token: await this.newSession(acc.user_id) };
  }

  logout(request) {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('authorization') || '');
    return m ? sha256hex(m[1]).then((h) => { this.run('DELETE FROM web_sessions WHERE token_hash=?', h); return { ok: true }; }) : { ok: true };
  }

  /* ───────── الشحن عبر Sifalo Pay (صفحة دفع مستضافة) ───────── */
  sifaloHosts() {
    return this.staging
      ? { api: 'https://spay-api.sifalo.net/gateway/', checkout: 'https://pay.sifalo.net/checkout/' }
      : { api: 'https://api.sifalopay.com/gateway/', checkout: 'https://pay.sifalo.com/checkout/' };
  }
  sifaloAuth() { return 'Basic ' + btoa(`${this.sifaloUser}:${this.sifaloKey}`); }

  // ينشئ جلسة دفع لدى Sifalo بمبلغ cents ويرجع رابط صفحة الدفع. plans: قائمة باقات تُشترى تلقائيًا بعد نجاح الدفع
  async sifaloSession(user, origin, cents, plans = null) {
    if (!this.sifalo && !this.dev) throw httpErr(503, 'الدفع غير مفعّل بعد');
    const ref = randHex(12);
    this.run('INSERT INTO topups(ref,user_id,cents,gw_key,status,created,plans) VALUES (?,?,?,?,?,?,?)', ref, user.id, cents, '', 'pending', now(), plans ? JSON.stringify(plans) : null);
    if (!this.sifalo) { // وضع التجربة بدون بوابة دفع
      this.run("UPDATE topups SET gw_key='dev' WHERE ref=?", ref);
      return { url: `${origin}/?topup=${ref}`, ref };
    }
    const h = this.sifaloHosts();
    const amount = (cents / 100).toFixed(2).replace(/\.00$/, '');
    let r = null;
    let j = null;
    try {
      r = await fetch(h.api, {
        method: 'POST',
        headers: { authorization: this.sifaloAuth(), 'content-type': 'application/json' },
        body: JSON.stringify({ amount, gateway: 'checkout', currency: 'USD', return_url: `${origin}/?topup=${ref}&order_id=${ref}` }),
      });
      j = await r.json().catch(() => null);
    } catch (e) { console.error('sifalo create', e.message); j = { error: 'network: ' + e.message }; }
    const key = j?.key ?? j?.data?.key;
    const token = j?.token ?? j?.data?.token;
    if (!r?.ok || !key || !token) {
      console.error('sifalo create failed', r?.status, JSON.stringify(j)?.slice(0, 300));
      this.run("UPDATE topups SET status='failed' WHERE ref=?", ref);
      const why = String(j?.message ?? j?.error ?? j?.response ?? '').replace(/[^\x20-\x7E\u0600-\u06FF]/g, '').slice(0, 120);
      const hint = r?.status === 401 || r?.status === 403 ? ' (تحقق من مفتاح Sifalo وأنه يطابق البيئة live/staging)' : '';
      throw httpErr(502, `تعذّر فتح صفحة الدفع [${r?.status ?? 'لا اتصال'}${why ? ': ' + why : ''}]${hint}`);
    }
    this.run('UPDATE topups SET gw_key=? WHERE ref=?', String(key), ref);
    return { url: `${h.checkout}?key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`, ref };
  }

  // دفع مباشر للسلة: يُحسب المبلغ هنا في الخادم (لا نثق بأي سعر من المتصفح). أي رصيد متبقٍ للعميل يُستخدم أولًا.
  async webCheckout(user, origin, { plan_ids }) {
    if (user.id < WEB_BASE) throw httpErr(400, 'الدفع بالبطاقة لحسابات الموقع فقط');
    const ids = [...new Set((Array.isArray(plan_ids) ? plan_ids : []).map(Number).filter(Number.isInteger))].slice(0, 12);
    if (!ids.length) throw httpErr(400, 'السلة فارغة');
    const plans = ids.map((id) => this.planRow(id));
    if (plans.some((p) => !p)) throw httpErr(404, 'إحدى الباقات لم تعد موجودة. حدّث الصفحة');
    const bad = plans.find((p) => !this.isAvailable(p));
    if (bad) throw httpErr(409, `نفدت الكمية: ${bad.product} — ${bad.label}`);
    const total = plans.reduce((a, p) => a + p.price, 0);
    const bal = this.get('SELECT balance FROM users WHERE id=?', user.id).balance;
    const due = total - bal;
    if (due <= 0) { // رصيد سابق يكفي: نشتري مباشرة
      const orders = [];
      for (const p of plans) orders.push((await this.buy(user, { plan_id: p.id, method: 'wallet' })).order_id);
      return { done: true, orders };
    }
    return this.sifaloSession(user, origin, Math.max(due, 100), ids);
  }

  // التحقق يتم بمعرّف الطلب (order_id) العشوائي الذي أنشأناه نحن، لا بالـ sid القادم من المتصفح.
  // verify.php عندهم بلا مصادقة ويقبل أي sid، فلو وثقنا بالـ sid لاستطاع أحدهم تقديم دفعة تاجر آخر.
  async sifaloVerify(ref) {
    try {
      const r = await fetch(this.sifaloHosts().api + 'verify.php', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order_id: ref }),
      });
      const j = await r.json().catch(() => null);
      return r.ok ? j : null;
    } catch (e) { console.error('sifalo verify', e.message); return null; }
  }
  isPaid(j, t) {
    return !!j && String(j.status).toLowerCase() === 'success' && Number(j.code) === 601 && !!j.sid
      && Math.abs(Number(j.amount) - t.cents / 100) < 0.005
      && String(j.currency || 'USD').toUpperCase() === 'USD'
      && (!j.order_id || String(j.order_id) === t.ref);
  }

  // يضيف رصيد الشحنة مرة واحدة فقط (الحالة pending → paid داخل معاملة، وsid فريد فلا تُستخدم دفعة مرتين)
  creditTopup(t, sid, note) {
    try {
      return this.tx(() => {
        if (!this.all("UPDATE topups SET status='paid', sid=? WHERE ref=? AND status='pending' RETURNING ref", sid, t.ref).length) return false;
        this.addBalance(t.user_id, t.cents, note);
        const results = [];
        const result = { bought: [], missed: [] };
        let ids = [];
        try { ids = JSON.parse(t.plans || '[]'); } catch { ids = []; }
        for (const pid of ids) { // شراء الباقات التي دُفع من أجلها
          const plan = this.planRow(pid);
          const bal = this.get('SELECT balance FROM users WHERE id=?', t.user_id).balance;
          if (!plan || !this.isAvailable(plan) || bal < plan.price) { result.missed.push(pid); continue; }
          this.run('UPDATE users SET balance=balance-? WHERE id=?', plan.price, t.user_id);
          const orderId = this.insertOrder(t.user_id, plan, 'card', 'paid');
          this.run('INSERT INTO ledger(user_id,delta,note,created) VALUES (?,?,?,?)', t.user_id, -plan.price, `شراء ${plan.product} — ${plan.label}`, now());
          const r = this.fulfillTx(orderId);
          result.bought.push(orderId); results.push(r);
        }
        if (ids.length) this.run('UPDATE topups SET result=? WHERE ref=?', JSON.stringify(result), t.ref);
        return { results };
      });
    } catch (e) { console.error('credit topup', t.ref, e.message); return false; }
  }

  async settleTopups(user, ref = null) {
    const rows = ref
      ? this.all("SELECT * FROM topups WHERE ref=? AND user_id=? AND status='pending'", ref, user.id)
      : this.all("SELECT * FROM topups WHERE user_id=? AND status='pending' AND created>? AND checked<? ORDER BY created DESC LIMIT 3", user.id, now() - 86400, now() - 15);
    for (const t of rows) {
      this.run('UPDATE topups SET checked=? WHERE ref=?', now(), t.ref);
      let credited = false;
      if (t.gw_key === 'dev') { if (this.dev && !this.sifalo && ref) credited = this.creditTopup(t, `dev_${t.ref}`, `دفع عبر Sifalo — $${t.cents / 100}`); }
      else if (t.gw_key && this.sifalo) {
        const j = await this.sifaloVerify(t.ref);
        if (this.isPaid(j, t)) credited = this.creditTopup(t, String(j.sid), `دفع عبر Sifalo — $${t.cents / 100}`);
      }
      if (credited) for (const r of credited.results) await this.notifyOrder(r);
    }
  }

  /* ───────── الكتالوج والحالة ───────── */
  planRow(id) {
    return this.get(`SELECT pl.*, pr.name AS product,
      (SELECT COUNT(*) FROM stock s WHERE s.plan_id=pl.id AND s.order_id IS NULL) AS stock
      FROM plans pl JOIN products pr ON pr.id=pl.product_id WHERE pl.id=? AND pl.active=1 AND pr.active=1`, id);
  }
  isAvailable(pl) { return pl.manual === 1 || pl.stock > 0; }

  catalog() {
    const plans = this.all(`SELECT pl.*, (SELECT COUNT(*) FROM stock s WHERE s.plan_id=pl.id AND s.order_id IS NULL) AS stock
      FROM plans pl WHERE pl.active=1 ORDER BY pl.price, pl.id`);
    return this.all('SELECT * FROM products WHERE active=1 ORDER BY sort, id').map((p) => ({
      id: p.id, name: p.name, cat: p.cat, color: p.color, glyph: p.glyph, desc: p.descr, img: p.image ? `/media/${p.image}` : null,
      plans: plans.filter((x) => x.product_id === p.id).map((x) => ({
        id: x.id, label: x.label, price: x.price, stars: this.starsFor(x.price), available: this.isAvailable(x),
      })),
    })).filter((p) => p.plans.length);
  }

  publicConfig() {
    return { web: this.sifalo || this.dev, starsPerUsd: this.rate, topups: TOPUPS.map((d) => ({ usd: d, stars: d * this.rate })), support: this.support };
  }

  setting(k) { return this.get('SELECT v FROM settings WHERE k=?', k)?.v || ''; }
  bannersPublic() {
    return this.all('SELECT id, media_id, link FROM banners WHERE active=1 ORDER BY sort, id').map((b) => ({ id: b.id, img: `/media/${b.media_id}`, link: b.link || '' }));
  }

  catalogPublic() {
    return { config: this.publicConfig(), categories: CATEGORIES, products: this.catalog(), banners: this.bannersPublic(), site: { announce: this.setting('announce') } };
  }

  stateFor(user) {
    return {
      me: this.get('SELECT id,name,username,balance FROM users WHERE id=?', user.id),
      config: this.publicConfig(),
      categories: CATEGORIES,
      products: this.catalog(),
      orders: this.all(`SELECT o.id, o.price, o.stars, o.method, o.status, o.delivery, o.created,
          pr.name AS product, pr.color, pr.glyph, pl.label AS plan
        FROM orders o JOIN plans pl ON pl.id=o.plan_id JOIN products pr ON pr.id=pl.product_id
        WHERE o.user_id=? AND (o.status!='awaiting' OR o.created>?) ORDER BY o.id DESC LIMIT 50`, user.id, now() - 600),
      ledger: this.all('SELECT id, delta, note, created FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 30', user.id),
    };
  }

  /* ───────── الطلبات والتسليم ───────── */
  insertOrder(userId, plan, method, status, stars = null) {
    return this.get('INSERT INTO orders(user_id,plan_id,price,stars,method,status,created,updated) VALUES (?,?,?,?,?,?,?,?) RETURNING id',
      userId, plan.id, plan.price, stars, method, status, now(), now()).id;
  }

  // يُستدعى داخل معاملة. الطلب بحالة paid → delivered أو pending أو refunded.
  fulfillTx(orderId) {
    const o = this.get('SELECT * FROM orders WHERE id=?', orderId);
    if (!o || o.status !== 'paid') return null;
    const plan = this.planRow(o.plan_id);
    const s = this.get('SELECT id, content FROM stock WHERE plan_id=? AND order_id IS NULL ORDER BY id LIMIT 1', o.plan_id);
    let status;
    let delivery = null;
    if (s) {
      this.run('UPDATE stock SET order_id=? WHERE id=?', o.id, s.id);
      status = 'delivered';
      delivery = s.content;
    } else if (plan?.manual) {
      status = 'pending';
    } else {
      status = 'refunded';
      this.addBalance(o.user_id, o.price, `استرداد ${plan?.product ?? 'طلب'} (نفد المخزون)`);
    }
    this.run('UPDATE orders SET status=?, delivery=?, updated=? WHERE id=?', status, delivery, now(), o.id);
    return { orderId: o.id, userId: o.user_id, status, delivery, product: plan?.product, plan: plan?.label, price: o.price };
  }

  async notifyOrder(r) {
    if (!r) return;
    const title = `${esc(r.product)} — ${esc(r.plan)}`;
    if (r.status === 'delivered') {
      await this.say(r.userId, `✅ تم تسليم طلبك #${r.orderId}\n<b>${title}</b>\n\n<code>${esc(r.delivery)}</code>`);
    } else if (r.status === 'pending') {
      await this.say(r.userId, `⏳ استلمنا طلبك #${r.orderId}\n<b>${title}</b>\nنجهّز اشتراكك وسيصلك هنا فور الانتهاء.`);
      await this.tellAdmins(`🔔 طلب يحتاج تسليم يدوي #${r.orderId}\n${title}\nالعميل: <code>${r.userId}</code>\n\n/deliver ${r.orderId} النص`);
    } else if (r.status === 'refunded') {
      await this.say(r.userId, `نفد مخزون ${title}. أضفنا ${usd(r.price)} إلى محفظتك.`);
    }
  }

  async buy(user, { plan_id, method }) {
    const plan = this.planRow(Number(plan_id));
    if (!plan) throw httpErr(404, 'هذه الباقة لم تعد موجودة');
    if (!this.isAvailable(plan)) throw httpErr(409, 'نفدت الكمية حاليًا. جرّب لاحقًا');

    if (method === 'wallet') {
      const result = this.tx(() => {
        const r = this.all('UPDATE users SET balance=balance-? WHERE id=? AND balance>=? RETURNING id', plan.price, user.id, plan.price);
        if (!r.length) throw httpErr(402, 'رصيد المحفظة لا يكفي. اشحن المحفظة أولًا');
        const orderId = this.insertOrder(user.id, plan, 'wallet', 'paid');
        this.run('INSERT INTO ledger(user_id,delta,note,created) VALUES (?,?,?,?)', user.id, -plan.price, `شراء ${plan.product} — ${plan.label}`, now());
        return this.fulfillTx(orderId);
      });
      await this.notifyOrder(result);
      return { order_id: result.orderId };
    }
    if (method === 'stars') {
      if (user.id >= WEB_BASE) throw httpErr(400, 'الدفع بالنجوم متاح داخل تيليجرام فقط');
      const stars = this.starsFor(plan.price);
      const orderId = this.insertOrder(user.id, plan, 'stars', 'awaiting', stars);
      const invoice = await this.createInvoice({ title: plan.product.slice(0, 32), description: plan.label, payload: `o:${orderId}`, stars });
      return { order_id: orderId, invoice };
    }
    throw httpErr(400, 'طريقة الدفع غير معروفة');
  }

  async topup(user, { usd: amount }) {
    if (user.id >= WEB_BASE) throw httpErr(400, 'الشحن بالنجوم داخل تيليجرام فقط. استخدم الشحن بالبطاقة');
    if (!TOPUPS.includes(Number(amount))) throw httpErr(400, 'باقة الشحن غير صحيحة');
    const invoice = await this.createInvoice({
      title: 'شحن المحفظة', description: `إضافة $${amount} إلى رصيدك`, payload: `t:${user.id}:${amount}`, stars: Number(amount) * this.rate,
    });
    return { invoice };
  }

  async createInvoice({ title, description, payload, stars }) {
    if (!this.token && this.dev) return `dev:${payload}:${stars}`;
    // النجوم: العملة XTR بدون provider_token وعنصر واحد في prices
    return this.tg('createInvoiceLink', { title, description, payload, currency: 'XTR', prices: [{ label: title, amount: stars }] });
  }

  /* ───────── معالجة الدفع بالنجوم ───────── */
  processPayment(fromId, sp) {
    if (sp.currency !== 'XTR') return null;
    const stars = sp.total_amount;
    const [kind, a] = String(sp.invoice_payload).split(':');
    return this.tx(() => {
      const first = this.all('INSERT OR IGNORE INTO payments(charge_id,user_id,payload,stars,created) VALUES (?,?,?,?,?) RETURNING charge_id',
        sp.telegram_payment_charge_id, fromId, sp.invoice_payload, stars, now());
      if (!first.length) return { dup: true };

      // الرصيد دائمًا بحسب النجوم المدفوعة فعلًا، فلا يضيع مال العميل حتى لو تغيّر السعر
      if (kind === 't') {
        const cents = this.centsFor(stars);
        this.addBalance(fromId, cents, `شحن بالنجوم — ${stars} نجمة`);
        return { kind: 'topup', userId: fromId, cents, stars };
      }
      if (kind === 'o') {
        const o = this.get('SELECT * FROM orders WHERE id=?', Number(a));
        if (o && o.user_id === fromId && o.status === 'awaiting' && o.stars === stars) {
          this.run("UPDATE orders SET status='paid', updated=? WHERE id=?", now(), o.id);
          return { kind: 'order', result: this.fulfillTx(o.id) };
        }
        const cents = this.centsFor(stars);
        this.addBalance(fromId, cents, `استرداد دفعة بالنجوم — ${stars} نجمة`);
        return { kind: 'credited', userId: fromId, cents };
      }
      return { dup: true };
    });
  }

  async afterPayment(o) {
    if (!o || o.dup) return;
    if (o.kind === 'topup') await this.say(o.userId, `✅ تمت إضافة ${usd(o.cents)} إلى محفظتك (${o.stars} نجمة).`);
    else if (o.kind === 'order') await this.notifyOrder(o.result);
    else if (o.kind === 'credited') {
      await this.say(o.userId, `تعذّر إكمال الطلب بعد الدفع، فأضفنا ${usd(o.cents)} إلى محفظتك.`);
      await this.tellAdmins(`⚠️ دفعة بالنجوم لم تطابق طلبًا وتم تحويلها لمحفظة <code>${o.userId}</code> (${usd(o.cents)}).`);
    }
  }

  /* ───────── لوحة الإدارة (/admin) ───────── */
  async adminLogin({ password }) {
    if (!this.adminPassword) throw httpErr(503, 'لم تُضبط كلمة سر الإدارة (ADMIN_PASSWORD) في Cloudflare بعد');
    const f = this.get("SELECT * FROM login_fail WHERE email='__admin__'");
    if (f && f.until > now()) throw httpErr(429, 'محاولات كثيرة. حاول بعد 15 دقيقة');
    const same = safeEqual(await sha256hex(String(password || '')), await sha256hex(this.adminPassword));
    if (!same) {
      const n = (f?.n || 0) + 1;
      this.run("INSERT INTO login_fail(email,n,until) VALUES ('__admin__',?,?) ON CONFLICT(email) DO UPDATE SET n=excluded.n, until=excluded.until", n >= 5 ? 0 : n, n >= 5 ? now() + 900 : 0);
      throw httpErr(401, 'كلمة السر غير صحيحة');
    }
    this.run("DELETE FROM login_fail WHERE email='__admin__'");
    return { token: await this.newSession(-1, 12 * 3600) };
  }

  async requireAdmin(request) {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('authorization') || '');
    const row = m && this.get('SELECT user_id FROM web_sessions WHERE token_hash=? AND expires>?', await sha256hex(m[1]), now());
    if (!row || row.user_id !== -1) throw httpErr(401, 'انتهت جلسة الإدارة. سجّل الدخول من جديد');
    return m[1];
  }

  userLabel(r) { return r.email || (r.username ? `@${r.username}` : r.name) || `#${r.user_id ?? r.id}`; }

  async admin(route, request, url, body) {
    if (route === '/login') return this.adminLogin(body);
    const token = await this.requireAdmin(request);
    const usd2c = (v) => { const c = Math.round(Number(v) * 100); if (!Number.isFinite(c)) throw httpErr(400, 'اكتب رقمًا صحيحًا'); return c; };
    const g = (sql, ...p) => this.get(sql, ...p).n;

    if (route === '/logout') { this.run('DELETE FROM web_sessions WHERE token_hash=?', await sha256hex(token)); return { ok: true }; }

    if (route === '/sifalo/test') {
      if (!this.sifalo) throw httpErr(400, 'مفاتيح Sifalo غير مضافة في Cloudflare');
      const h = this.sifaloHosts();
      let r = null; let txt = '';
      try {
        r = await fetch(h.api, { method: 'POST', headers: { authorization: this.sifaloAuth(), 'content-type': 'application/json' },
          body: JSON.stringify({ amount: '1', gateway: 'checkout', currency: 'USD', return_url: `${new URL(request.url).origin}/?topup=test&order_id=test` }) });
        txt = await r.text();
      } catch (e) { txt = 'network: ' + e.message; }
      let j = null; try { j = JSON.parse(txt); } catch {}
      const ok = !!(r?.ok && (j?.key ?? j?.data?.key) && (j?.token ?? j?.data?.token));
      const mask = (v) => (v ? String(v).slice(0, 4) + '…' : v);
      const safe = j && typeof j === 'object' ? JSON.stringify({ ...j, key: mask(j.key), token: mask(j.token), data: undefined }) : txt.slice(0, 300);
      return { ok, status: r?.status ?? 0, env: this.staging ? 'staging' : 'live', host: h.api, user: this.sifaloUser.slice(0, 5) + '…', response: safe.slice(0, 400) };
    }

    if (route === '/overview') {
      const day = now() - 86400;
      return {
        users: g('SELECT COUNT(*) n FROM users'),
        webUsers: g('SELECT COUNT(*) n FROM web_accounts'),
        orders: {
          pending: g("SELECT COUNT(*) n FROM orders WHERE status='pending'"),
          delivered: g("SELECT COUNT(*) n FROM orders WHERE status='delivered'"),
          refunded: g("SELECT COUNT(*) n FROM orders WHERE status='refunded'"),
          today: g("SELECT COUNT(*) n FROM orders WHERE status IN ('pending','delivered') AND created>?", day),
        },
        salesCents: g("SELECT COALESCE(SUM(price),0) n FROM orders WHERE status IN ('pending','delivered')"),
        salesTodayCents: g("SELECT COALESCE(SUM(price),0) n FROM orders WHERE status IN ('pending','delivered') AND created>?", day),
        topupsCents: g("SELECT COALESCE(SUM(cents),0) n FROM topups WHERE status='paid'"),
        stars: g('SELECT COALESCE(SUM(stars),0) n FROM payments'),
        walletsCents: g('SELECT COALESCE(SUM(balance),0) n FROM users'),
        pendingTopups: g("SELECT COUNT(*) n FROM topups WHERE status='pending' AND gw_key!='' AND created>?", day),
        lowStock: this.all(`SELECT pl.id, pr.name, pl.label,
            (SELECT COUNT(*) FROM stock s WHERE s.plan_id=pl.id AND s.order_id IS NULL) AS stock
          FROM plans pl JOIN products pr ON pr.id=pl.product_id
          WHERE pl.active=1 AND pr.active=1 AND pl.manual=0 AND stock<=2 ORDER BY stock, pl.id`),
        sifalo: this.sifalo, staging: this.staging, telegram: !!this.token,
      };
    }

    if (route === '/orders') {
      const st = ['pending', 'delivered', 'refunded'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : '';
      return { orders: this.all(`SELECT o.id, o.user_id, o.price, o.method, o.status, o.delivery, o.created, pr.name AS product, pl.label AS plan,
          u.name, u.username, wa.email
        FROM orders o JOIN plans pl ON pl.id=o.plan_id JOIN products pr ON pr.id=pl.product_id
        LEFT JOIN users u ON u.id=o.user_id LEFT JOIN web_accounts wa ON wa.user_id=o.user_id
        WHERE o.status!='awaiting' AND (?='' OR o.status=?) ORDER BY o.id DESC LIMIT 100`, st, st) .map((r) => ({ ...r, who: this.userLabel(r) })) };
    }

    if (route === '/deliver') {
      const id = Number(body.id);
      const text = String(body.text || '').trim().slice(0, 2000);
      const o = this.get("SELECT * FROM orders WHERE id=? AND status='pending'", id);
      if (!o) throw httpErr(404, 'الطلب غير موجود أو ليس بانتظار التسليم');
      if (!text) throw httpErr(400, 'اكتب بيانات الاشتراك التي تُسلَّم للعميل');
      this.run("UPDATE orders SET status='delivered', delivery=?, updated=? WHERE id=?", text, now(), id);
      const pl = this.planRow(o.plan_id);
      await this.notifyOrder({ orderId: id, userId: o.user_id, status: 'delivered', delivery: text, product: pl?.product, plan: pl?.label });
      return { ok: true };
    }

    if (route === '/refund') {
      const o = this.get('SELECT * FROM orders WHERE id=?', Number(body.id));
      if (!o || !['pending', 'delivered'].includes(o.status)) throw httpErr(400, 'هذا الطلب لا يمكن استرداده');
      if (o.method !== 'wallet') throw httpErr(400, 'طلبات النجوم تُسترد من تيليجرام بالأمر /refund');
      this.tx(() => {
        this.addBalance(o.user_id, o.price, `استرداد الطلب #${o.id}`);
        this.run("UPDATE orders SET status='refunded', updated=? WHERE id=?", now(), o.id);
      });
      await this.say(o.user_id, `تم استرداد طلبك #${o.id} إلى محفظتك.`);
      return { ok: true };
    }

    if (route === '/catalog') {
      const plans = this.all(`SELECT pl.*, (SELECT COUNT(*) FROM stock s WHERE s.plan_id=pl.id AND s.order_id IS NULL) AS stock FROM plans pl ORDER BY pl.id`);
      return {
        categories: CATEGORIES,
        products: this.all('SELECT * FROM products ORDER BY sort, id').map((p) => ({
          id: p.id, name: p.name, cat: p.cat, color: p.color, glyph: p.glyph, desc: p.descr, active: p.active, img: p.image ? `/media/${p.image}` : null,
          plans: plans.filter((x) => x.product_id === p.id).map((x) => ({ id: x.id, label: x.label, price: x.price, manual: x.manual, active: x.active, stock: x.stock })),
        })),
      };
    }

    if (route === '/plan/update') {
      const pl = this.get('SELECT * FROM plans WHERE id=?', Number(body.id));
      if (!pl) throw httpErr(404, 'الباقة غير موجودة');
      const price = body.price !== undefined ? usd2c(body.price) : pl.price;
      if (price <= 0 || price > 1000000) throw httpErr(400, 'السعر غير صحيح');
      const label = body.label !== undefined ? String(body.label).trim().slice(0, 60) : pl.label;
      if (!label) throw httpErr(400, 'اسم الباقة فارغ');
      this.run('UPDATE plans SET price=?, label=?, active=?, manual=? WHERE id=?', price, label,
        body.active !== undefined ? (body.active ? 1 : 0) : pl.active, body.manual !== undefined ? (body.manual ? 1 : 0) : pl.manual, pl.id);
      return { ok: true };
    }

    if (route === '/product/update') {
      const p = this.get('SELECT * FROM products WHERE id=?', Number(body.id));
      if (!p) throw httpErr(404, 'المنتج غير موجود');
      const name = body.name !== undefined ? String(body.name).trim().slice(0, 60) : p.name;
      if (!name) throw httpErr(400, 'اسم المنتج فارغ');
      this.run('UPDATE products SET name=?, descr=?, active=? WHERE id=?', name,
        body.desc !== undefined ? String(body.desc).trim().slice(0, 200) : p.descr, body.active !== undefined ? (body.active ? 1 : 0) : p.active, p.id);
      return { ok: true };
    }

    if (route === '/product/add') {
      const name = String(body.name || '').trim().slice(0, 60);
      const glyph = String(body.glyph || '').trim().slice(0, 2);
      if (!name || !glyph) throw httpErr(400, 'اكتب اسم المنتج ورمزه (حرف أو حرفان)');
      if (!CATEGORIES.some((c) => c.key === body.cat)) throw httpErr(400, 'اختر تصنيفًا');
      if (!/^#[0-9a-fA-F]{6}$/.test(String(body.color || ''))) throw httpErr(400, 'اللون يكتب هكذا: #FF5577');
      const sort = g('SELECT COALESCE(MAX(sort),0)+1 n FROM products');
      const r = this.get('INSERT INTO products(name,cat,color,glyph,descr,sort) VALUES (?,?,?,?,?,?) RETURNING id', name, body.cat, body.color, glyph, String(body.desc || '').trim().slice(0, 200), sort);
      return { id: r.id };
    }

    if (route === '/plan/add') {
      const label = String(body.label || '').trim().slice(0, 60);
      const price = usd2c(body.price);
      if (!this.get('SELECT 1 AS x FROM products WHERE id=?', Number(body.product_id))) throw httpErr(404, 'المنتج غير موجود');
      if (!label || price <= 0) throw httpErr(400, 'اكتب اسم الباقة وسعرها');
      const r = this.get('INSERT INTO plans(product_id,label,price,manual) VALUES (?,?,?,?) RETURNING id', Number(body.product_id), label, price, body.manual ? 1 : 0);
      return { id: r.id };
    }

    if (route === '/stock') {
      const lines = String(body.lines || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 500);
      if (!this.get('SELECT 1 AS x FROM plans WHERE id=?', Number(body.plan_id))) throw httpErr(404, 'الباقة غير موجودة');
      if (!lines.length) throw httpErr(400, 'اكتب عنصرًا واحدًا على الأقل، كل سطر لعميل');
      this.tx(() => { for (const c of lines) this.run('INSERT INTO stock(plan_id,content) VALUES (?,?)', Number(body.plan_id), c.slice(0, 1000)); });
      return { added: lines.length };
    }

    if (route === '/users') {
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 60);
      const like = `%${q.replace(/[%_]/g, '')}%`;
      return { users: this.all(`SELECT u.id, u.name, u.username, u.balance, u.created, wa.email,
          (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id AND o.status IN ('pending','delivered')) AS orders
        FROM users u LEFT JOIN web_accounts wa ON wa.user_id=u.id
        WHERE ?='' OR u.name LIKE ? OR wa.email LIKE ? OR u.username LIKE ? OR CAST(u.id AS TEXT)=? ORDER BY u.created DESC LIMIT 50`, q, like, like, like, q)
        .map((r) => ({ ...r, label: this.userLabel(r) })) };
    }

    if (route === '/credit') {
      const uid = Number(body.user_id);
      const cents = usd2c(body.amount);
      if (!cents || Math.abs(cents) > 10000000) throw httpErr(400, 'المبلغ غير صحيح');
      const u = this.get('SELECT * FROM users WHERE id=?', uid);
      if (!u) throw httpErr(404, 'المستخدم غير موجود');
      if (cents < 0 && u.balance + cents < 0) throw httpErr(400, 'الخصم أكبر من رصيد العميل');
      const note = String(body.note || '').trim().slice(0, 80);
      this.tx(() => this.addBalance(uid, cents, note || (cents > 0 ? 'رصيد من الإدارة' : 'خصم من الإدارة')));
      await this.say(uid, `تم تعديل رصيد محفظتك: ${cents > 0 ? '+' : '−'}${usd(Math.abs(cents))}`);
      return { balance: this.get('SELECT balance FROM users WHERE id=?', uid).balance };
    }

    if (route === '/topups') {
      return { topups: this.all(`SELECT t.ref, t.user_id, t.cents, t.status, t.created, t.sid, u.name, u.username, wa.email
        FROM topups t LEFT JOIN users u ON u.id=t.user_id LEFT JOIN web_accounts wa ON wa.user_id=t.user_id
        WHERE t.gw_key!='' ORDER BY t.created DESC LIMIT 60`).map((r) => ({ ...r, who: this.userLabel(r) })) };
    }

    if (route === '/topup/verify') {
      const t = this.get("SELECT * FROM topups WHERE ref=? AND gw_key!=''", String(body.ref || ''));
      if (!t) throw httpErr(404, 'الشحنة غير موجودة');
      await this.settleTopups(this.get('SELECT * FROM users WHERE id=?', t.user_id), t.ref);
      return { status: this.get('SELECT status FROM topups WHERE ref=?', t.ref).status };
    }

    if (route === '/topup/credit') { // إضافة يدوية بعد أن تتأكد بنفسك من وصول المبلغ في لوحة Sifalo
      const t = this.get("SELECT * FROM topups WHERE ref=? AND status IN ('pending','failed')", String(body.ref || ''));
      if (!t) throw httpErr(404, 'الشحنة غير موجودة أو مكتملة');
      this.run("UPDATE topups SET status='pending' WHERE ref=?", t.ref);
      const done = this.creditTopup({ ...t, status: 'pending' }, `manual_${t.ref}`, `شحن (إضافة يدوية) — $${t.cents / 100}`);
      if (done) { for (const r of done.results) await this.notifyOrder(r); if (!done.results.length) await this.say(t.user_id, `تمت إضافة ${usd(t.cents)} إلى حسابك.`); }
      return { ok: !!done };
    }

    if (route === '/appearance') {
      return {
        announce: this.setting('announce'),
        banners: this.all('SELECT id, media_id, link, sort, active FROM banners ORDER BY sort, id').map((b) => ({ ...b, img: `/media/${b.media_id}` })),
      };
    }

    if (route === '/media/upload') { // يستقبل صورة كـ data URL (تُصغَّر في المتصفح قبل الرفع)
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
      if (!m) throw httpErr(400, 'الصورة يجب أن تكون JPG أو PNG أو WEBP');
      if (m[2].length > 1_400_000) throw httpErr(413, 'الصورة كبيرة. اختر صورة أصغر');
      const head = atob(m[2].slice(0, 16));
      const okMagic = (m[1] === 'image/jpeg' && head.startsWith('\xff\xd8\xff')) || (m[1] === 'image/png' && head.startsWith('\x89PNG')) || (m[1] === 'image/webp' && head.startsWith('RIFF'));
      if (!okMagic) throw httpErr(400, 'ملف الصورة غير صالح');
      const r = this.get('INSERT INTO media(mime,data,created) VALUES (?,?,?) RETURNING id', m[1], m[2], now());
      return { id: r.id, url: `/media/${r.id}` };
    }

    if (route === '/banner/add') {
      const mid = Number(body.media_id);
      if (!this.get('SELECT 1 AS x FROM media WHERE id=?', mid)) throw httpErr(404, 'الصورة غير موجودة');
      const link = String(body.link || '').trim().slice(0, 300);
      if (link && !/^(https?:\/\/|#\/|\/)/.test(link)) throw httpErr(400, 'الرابط يبدأ بـ https:// أو #/');
      const sort = g('SELECT COALESCE(MAX(sort),0)+1 n FROM banners');
      return { id: this.get('INSERT INTO banners(media_id,link,sort) VALUES (?,?,?) RETURNING id', mid, link, sort).id };
    }
    if (route === '/banner/update') {
      const b = this.get('SELECT * FROM banners WHERE id=?', Number(body.id));
      if (!b) throw httpErr(404, 'البانر غير موجود');
      const link = body.link !== undefined ? String(body.link).trim().slice(0, 300) : b.link;
      if (link && !/^(https?:\/\/|#\/|\/)/.test(link)) throw httpErr(400, 'الرابط يبدأ بـ https:// أو #/');
      this.run('UPDATE banners SET link=?, active=? WHERE id=?', link, body.active !== undefined ? (body.active ? 1 : 0) : b.active, b.id);
      return { ok: true };
    }
    if (route === '/banner/delete') {
      const b = this.get('DELETE FROM banners WHERE id=? RETURNING media_id', Number(body.id));
      if (b) this.run('DELETE FROM media WHERE id=?', b.media_id);
      return { ok: true };
    }
    if (route === '/product/image') { // media_id = null يحذف الصورة
      const p = this.get('SELECT * FROM products WHERE id=?', Number(body.id));
      if (!p) throw httpErr(404, 'المنتج غير موجود');
      let mid = null;
      if (body.media_id) {
        mid = Number(body.media_id);
        if (!this.get('SELECT 1 AS x FROM media WHERE id=?', mid)) throw httpErr(404, 'الصورة غير موجودة');
      }
      this.run('UPDATE products SET image=? WHERE id=?', mid, p.id);
      if (p.image && p.image !== mid) this.run('DELETE FROM media WHERE id=?', p.image);
      return { ok: true };
    }
    if (route === '/settings') {
      if (body.announce !== undefined) this.run('INSERT INTO settings(k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', 'announce', String(body.announce).trim().slice(0, 160));
      return { ok: true };
    }

    throw httpErr(404, 'غير موجود');
  }

  /* ───────── البوت (Webhook) ───────── */
  async handleUpdate(u, origin) {
    if (u.pre_checkout_query) {
      const q = u.pre_checkout_query;
      let ok = true;
      let error_message;
      const [kind, a] = String(q.invoice_payload).split(':');
      if (kind === 'o') {
        const o = this.get('SELECT * FROM orders WHERE id=?', Number(a));
        const pl = o && this.planRow(o.plan_id);
        if (!o || o.status !== 'awaiting' || !pl || !this.isAvailable(pl)) {
          ok = false;
          error_message = 'نفدت الكمية أو انتهى الطلب. افتح المتجر وأعد المحاولة';
        }
      }
      await this.tg('answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok, ...(ok ? {} : { error_message }) });
      return;
    }
    const m = u.message;
    if (!m) return;
    if (m.successful_payment) {
      this.upsertUser(m.from);
      await this.afterPayment(this.processPayment(m.from.id, m.successful_payment));
      return;
    }
    if (m.text?.startsWith('/')) await this.command(m, origin);
  }

  isAdmin(id) { return this.admins.includes(id); }

  async command(m, origin) {
    const lines = m.text.split('\n');
    const [head, ...args] = lines[0].trim().split(/\s+/);
    const cmd = head.split('@')[0].toLowerCase();
    const chat = m.chat.id;
    const say = (t, x) => this.say(chat, t, x);

    if (cmd === '/start') {
      this.upsertUser(m.from);
      return say('أهلًا بك في المتجر.\nاشترك في خدماتك المفضلة، وادفع بالنجوم أو من محفظتك.',
        { reply_markup: { inline_keyboard: [[{ text: 'افتح المتجر', web_app: { url: origin } }]] } });
    }
    if (cmd === '/paysupport') {
      return say(this.support ? `لأي مشكلة في الدفع أو الطلبات تواصل مع @${this.support} وأرسل رقم الطلب.` : 'لأي مشكلة في الدفع أرسل رقم طلبك هنا وسنراجعه.');
    }
    if (!this.isAdmin(m.from.id)) return;

    if (cmd === '/stats') {
      const g = (sql) => this.get(sql).n;
      return say(
        `المستخدمون: ${g('SELECT COUNT(*) n FROM users')}\n` +
        `الطلبات المسلّمة: ${g("SELECT COUNT(*) n FROM orders WHERE status='delivered'")}\n` +
        `بانتظار التسليم: ${g("SELECT COUNT(*) n FROM orders WHERE status='pending'")}\n` +
        `نجوم مستلمة: ${g('SELECT COALESCE(SUM(stars),0) n FROM payments')} ★`);
    }
    if (cmd === '/plans') {
      const rows = this.all(`SELECT pl.id, pl.active AS pa, pr.id AS pid, pr.name, pr.active AS pra, pl.label, pl.price, pl.manual,
        (SELECT COUNT(*) FROM stock s WHERE s.plan_id=pl.id AND s.order_id IS NULL) AS stock
        FROM plans pl JOIN products pr ON pr.id=pl.product_id ORDER BY pr.sort, pr.id, pl.id`);
      return say(rows.map((r) => `باقة <code>${r.id}</code> | منتج <code>${r.pid}</code> ${esc(r.name)} — ${esc(r.label)} (${usd(r.price)}) ` +
        `مخزون ${r.stock}${r.manual ? ' يدوي' : ''}${r.pa && r.pra ? '' : ' [مخفي]'}`).join('\n'));
    }
    if (cmd === '/addstock') {
      const planId = Number(args[0]);
      const items = lines.slice(1).map((l) => l.trim()).filter(Boolean);
      if (!planId || !items.length || !this.get('SELECT 1 AS x FROM plans WHERE id=?', planId)) return say('الصيغة:\n/addstock رقم_الباقة\nكل سطر بعده = حساب أو كود');
      this.tx(() => { for (const c of items) this.run('INSERT INTO stock(plan_id,content) VALUES (?,?)', planId, c); });
      return say(`أُضيف ${items.length} عنصر إلى الباقة ${planId}.`);
    }
    if (cmd === '/setprice') {
      const cents = Math.round(Number(args[1]) * 100);
      const r = cents > 0 && this.all('UPDATE plans SET price=? WHERE id=? RETURNING id', cents, Number(args[0]));
      return say(r?.length ? `تم: سعر الباقة ${args[0]} صار ${usd(cents)}.` : 'الصيغة: /setprice رقم_الباقة السعر_بالدولار');
    }
    if (cmd === '/addplan') { // /addplan رقم_المنتج السعر يدوي(0/1) الاسم...
      const [pid, price, manual, ...label] = args;
      const cents = Math.round(Number(price) * 100);
      if (!this.get('SELECT 1 AS x FROM products WHERE id=?', Number(pid)) || !(cents > 0) || !['0', '1'].includes(manual) || !label.length) {
        return say('الصيغة: /addplan رقم_المنتج السعر_بالدولار يدوي(1)_أو_مخزون(0) اسم الباقة\nمثال: /addplan 3 12.5 1 6 أشهر');
      }
      const r = this.get('INSERT INTO plans(product_id,label,price,manual) VALUES (?,?,?,?) RETURNING id', Number(pid), label.join(' '), cents, Number(manual));
      return say(`أُضيفت الباقة رقم ${r.id}.`);
    }
    if (cmd === '/addproduct') { // /addproduct الاسم|التصنيف|#لون|رمز|الوصف
      const [name, cat, color, glyph, desc] = lines[0].replace(/^\S+\s*/, '').split('|').map((s) => s.trim());
      if (!name || !CATEGORIES.some((c) => c.key === cat) || !/^#[0-9a-fA-F]{6}$/.test(color || '') || !glyph) {
        return say(`الصيغة: /addproduct الاسم|التصنيف|#لون|رمز|الوصف\nالتصنيفات: ${CATEGORIES.map((c) => c.key).join(', ')}\nمثال: /addproduct Max|video|#FF5577|M|وصف قصير`);
      }
      const sort = (this.get('SELECT COALESCE(MAX(sort),0)+1 AS n FROM products').n);
      const r = this.get('INSERT INTO products(name,cat,color,glyph,descr,sort) VALUES (?,?,?,?,?,?) RETURNING id', name, cat, color, glyph.slice(0, 2), desc || '', sort);
      return say(`أُضيف المنتج رقم ${r.id}. الآن أضف له باقات بالأمر /addplan ${r.id} ...`);
    }
    if (cmd === '/hide' || cmd === '/show') { // /hide plan|product رقم
      const table = { plan: 'plans', product: 'products' }[args[0]];
      const r = table && this.all(`UPDATE ${table} SET active=? WHERE id=? RETURNING id`, cmd === '/show' ? 1 : 0, Number(args[1]));
      return say(r?.length ? 'تم.' : `الصيغة: ${cmd} plan|product الرقم`);
    }
    if (cmd === '/pending') {
      const rows = this.all(`SELECT o.id, o.user_id, pr.name, pl.label FROM orders o
        JOIN plans pl ON pl.id=o.plan_id JOIN products pr ON pr.id=pl.product_id WHERE o.status='pending' ORDER BY o.id`);
      return say(rows.length ? rows.map((r) => `#${r.id} ${esc(r.name)} — ${esc(r.label)} (<code>${r.user_id}</code>)`).join('\n') : 'لا توجد طلبات معلّقة.');
    }
    if (cmd === '/deliver') {
      const id = Number(args[0]);
      const text = m.text.replace(/^\S+\s+\d+\s*/, '').trim();
      const o = this.get("SELECT * FROM orders WHERE id=? AND status='pending'", id);
      if (!o || !text) return say('الصيغة:\n/deliver رقم_الطلب النص\nويجب أن يكون الطلب معلّقًا.');
      this.run("UPDATE orders SET status='delivered', delivery=?, updated=? WHERE id=?", text, now(), id);
      const pl = this.planRow(o.plan_id);
      await this.notifyOrder({ orderId: id, userId: o.user_id, status: 'delivered', delivery: text, product: pl?.product, plan: pl?.label });
      return say(`تم تسليم الطلب #${id}.`);
    }
    if (cmd === '/credit') {
      const uid = Number(args[0]);
      const amount = Math.round(Number(args[1]) * 100);
      if (!uid || !amount || !this.get('SELECT 1 AS x FROM users WHERE id=?', uid)) return say('الصيغة: /credit معرّف_المستخدم المبلغ_بالدولار');
      this.tx(() => this.addBalance(uid, amount, amount > 0 ? 'رصيد من الإدارة' : 'خصم من الإدارة'));
      await this.say(uid, `تم تعديل رصيد محفظتك: ${amount > 0 ? '+' : '−'}${usd(Math.abs(amount))}`);
      return say('تم.');
    }
    if (cmd === '/refund') {
      const o = this.get('SELECT * FROM orders WHERE id=?', Number(args[0]));
      if (!o || !['pending', 'delivered'].includes(o.status)) return say('الصيغة: /refund رقم_الطلب (طلب مدفوع غير مسترد)');
      if (o.method === 'stars') {
        const pay = this.get('SELECT charge_id FROM payments WHERE payload=?', `o:${o.id}`);
        if (!pay) return say('لا توجد دفعة مرتبطة بهذا الطلب.');
        await this.tg('refundStarPayment', { user_id: o.user_id, telegram_payment_charge_id: pay.charge_id });
      } else {
        this.tx(() => this.addBalance(o.user_id, o.price, `استرداد الطلب #${o.id}`));
      }
      this.run("UPDATE orders SET status='refunded', updated=? WHERE id=?", now(), o.id);
      await this.say(o.user_id, `تم استرداد طلبك #${o.id}.`);
      return say(`تم استرداد الطلب #${o.id}.`);
    }
  }

  /* ───────── نقطة الدخول ───────── */
  async fetch(request) {
    const url = new URL(request.url);
    try {
      // ربط البوت بهذا الرابط (مرة واحدة): افتح /setup/<WEBHOOK_SECRET> في المتصفح
      if (url.pathname.startsWith('/setup/')) {
        const secret = this.env.WEBHOOK_SECRET || '';
        if (!secret || decodeURIComponent(url.pathname.slice(7)) !== secret) return json({ error: 'غير مصرّح' }, 403);
        await this.tg('setWebhook', {
          url: `${url.origin}/tg`, secret_token: secret, allowed_updates: ['message', 'pre_checkout_query'], drop_pending_updates: true,
        });
        await this.tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'المتجر', web_app: { url: url.origin } } });
        await this.tg('setMyCommands', { commands: [{ command: 'start', description: 'فتح المتجر' }, { command: 'paysupport', description: 'مشاكل الدفع' }] });
        return json({ ok: true, store: url.origin, note: 'تم ربط البوت. افتحه في تيليجرام وأرسل /start' });
      }

      // استقبال تحديثات تيليجرام
      if (url.pathname === '/tg' && request.method === 'POST') {
        if (!this.env.WEBHOOK_SECRET || request.headers.get('x-telegram-bot-api-secret-token') !== this.env.WEBHOOK_SECRET) {
          return new Response('forbidden', { status: 403 });
        }
        try { await this.handleUpdate(await request.json(), url.origin); } catch (e) { console.error('update', e); }
        return new Response('ok'); // دائمًا 200 حتى لا يعيد تيليجرام الإرسال
      }

      // الصور المرفوعة (عامة، والمعرّفات لا تتكرر فيُخزَّن الرد طويلًا)
      if (url.pathname.startsWith('/media/') && request.method === 'GET') {
        const m = this.get('SELECT mime, data FROM media WHERE id=?', Number(url.pathname.slice(7)));
        if (!m) return new Response('Not found', { status: 404 });
        const bin = Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0));
        return new Response(bin, { headers: { 'content-type': m.mime, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
      }

      // واجهة المتجر
      if (url.pathname.startsWith('/api/')) {
        const route = url.pathname.slice(4);
        const body = async () => { try { return await request.json(); } catch { throw httpErr(400, 'طلب غير صالح'); } };
        if (route.startsWith('/admin/')) return json(await this.admin(route.slice(6), request, url, request.method === 'GET' ? {} : await body()));
        if (request.method === 'GET' && route === '/catalog') return json(this.catalogPublic());
        if (request.method === 'POST' && route === '/web/signup') return json(await this.signup(await body()));
        if (request.method === 'POST' && route === '/web/login') return json(await this.login(await body()));
        const user = await this.auth(request);
        if (request.method === 'POST' && route === '/web/logout') return json(await this.logout(request));
        if (request.method === 'POST' && route === '/web/checkout') return json(await this.webCheckout(user, url.origin, await body()));
        if (request.method === 'POST' && route === '/web/topup/check') {
          const { ref } = await body();
          await this.settleTopups(user, String(ref || ''));
          const t = this.get('SELECT status, cents, result FROM topups WHERE ref=? AND user_id=?', String(ref || ''), user.id);
          let result = null; try { result = t?.result ? JSON.parse(t.result) : null; } catch {}
          return json({ status: t?.status || 'none', cents: t?.cents || 0, result });
        }
        if (request.method === 'GET' && route === '/state') {
          if (user.id >= WEB_BASE) await this.settleTopups(user);
          return json(this.stateFor(user));
        }
        if (request.method === 'POST' && route === '/buy') return json(await this.buy(user, await body()));
        if (request.method === 'POST' && route === '/topup') return json(await this.topup(user, await body()));
        if (this.dev && !this.token && request.method === 'POST' && route === '/dev/pay') {
          const b = await body();
          const o = this.processPayment(user.id, {
            currency: 'XTR', invoice_payload: b.payload, total_amount: Number(b.stars),
            telegram_payment_charge_id: `dev_${crypto.randomUUID()}`,
          });
          await this.afterPayment(o);
          return json({ ok: true });
        }
      }
      return json({ error: 'غير موجود' }, 404);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return json({ error: status === 500 ? 'حدث خطأ غير متوقع. حاول مرة أخرى' : e.message }, status);
    }
  }
}

/* ───────── الواجهة (ملفات ثابتة مدمجة) ───────── */
const ASSETS = {"/index.html":{"type":"text/html; charset=utf-8","body":"<!doctype html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n  <meta name=\"theme-color\" content=\"#f6f1e6\">\n  <meta name=\"description\" content=\"MO7 — اشتراكات رقمية بأسعار واضحة. ادفع بالبطاقة (Visa / Mastercard) واستلم اشتراكك بسرعة.\">\n  <title>MO7</title>\n  <link rel=\"icon\" type=\"image/webp\" href=\"/logo.webp\">\n  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n  <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n  <link href=\"https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@300;400;500;600;700&family=Reem+Kufi:wght@500;600;700&display=swap\" rel=\"stylesheet\">\n  <link rel=\"stylesheet\" href=\"/app.css?v=mv8yx8u1\">\n</head>\n<body>\n  <div id=\"app\"><div class=\"boot\"><span class=\"spin\"></span></div></div>\n  <div id=\"overlay\" hidden></div>\n  <div id=\"toast\" role=\"status\" aria-live=\"polite\"></div>\n  <script src=\"/app.js?v=mv8yx8u1\"></script>\n</body>\n</html>\n"},"/app.css":{"type":"text/css; charset=utf-8","body":":root {\n  --bg: #f6f1e6; --surface: #fffdf8; --ink: #2a1418; --ink2: #6a5558; --ink3: #9a8a8c; --line: #e8dfcf; --line2: #d9ccb8;\n  --brand: #7d1626; --brand-d: #5f0f1c; --brand-l: #f4e3e2; --gold: #b98a3e;\n  --ok: #17703b; --ok-bg: #e6f3ea; --warn: #8a5a0b; --warn-bg: #fbefd6; --bad: #a3171f; --bad-bg: #fbe5e4;\n  --r: 16px; --wrap: 1160px;\n}\n* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }\nhtml { scroll-behavior: smooth; }\nbody { margin: 0; background: var(--bg); color: var(--ink); font: 400 15px/1.7 'IBM Plex Sans Arabic', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }\nbutton, input, select { font: inherit; color: inherit; }\nbutton { cursor: pointer; }\na { color: inherit; text-decoration: none; }\nh1, h2, h3, p { margin: 0; }\nh1, h2, h3 { text-wrap: balance; line-height: 1.35; font-family: 'Reem Kufi', 'IBM Plex Sans Arabic', sans-serif; font-weight: 600; }\nbdi { unicode-bidi: isolate; }\n.wrap { max-width: var(--wrap); margin: 0 auto; padding-inline: max(16px, env(safe-area-inset-right, 0px)) max(16px, env(safe-area-inset-left, 0px)); }\n.boot { min-height: 100vh; display: grid; place-items: center; color: var(--brand); }\n.spin { width: 22px; height: 22px; border: 3px solid currentColor; border-inline-end-color: transparent; border-radius: 50%; display: inline-block; animation: sp .7s linear infinite; vertical-align: middle; }\n@keyframes sp { to { transform: rotate(360deg); } }\n.ico { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; flex: none; }\n:focus-visible { outline: 3px solid color-mix(in srgb, var(--brand) 40%, transparent); outline-offset: 2px; }\n\n/* الهيدر */\n.announce { background: var(--brand); color: #fbeee9; font-size: 13px; text-align: center; padding: 7px 12px; }\n.header { background: color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter: saturate(1.4) blur(10px); -webkit-backdrop-filter: saturate(1.4) blur(10px); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 30; }\n.hrow { display: flex; align-items: center; gap: 16px; padding-block: 10px; }\n.logo { flex: none; display: block; line-height: 0; }\n.logo img { height: 46px; width: auto; display: block; }\n.search { flex: 1; position: relative; max-width: 520px; margin-inline: auto; }\n.search input { width: 100%; height: 44px; border: 1px solid var(--line2); border-radius: 99px; background: var(--surface); padding-inline: 46px 18px; outline: none; transition: border-color .15s, box-shadow .15s; }\n.search input:focus { border-color: var(--brand); box-shadow: 0 0 0 4px color-mix(in srgb, var(--brand) 12%, transparent); }\n.search .ico { position: absolute; inset-inline-start: 16px; top: 12px; color: var(--ink3); width: 20px; height: 20px; }\n.hact { display: flex; align-items: center; gap: 8px; margin-inline-start: auto; }\n.hbtn { position: relative; height: 44px; min-width: 44px; padding-inline: 14px; border: 1px solid var(--line2); border-radius: 99px; background: var(--surface); display: inline-flex; align-items: center; justify-content: center; gap: 8px; font-weight: 500; font-size: 14px; transition: background .15s, border-color .15s; }\n.hbtn:hover { border-color: var(--brand); }\n.hbtn.solid { background: var(--brand); color: #fff; border-color: var(--brand); }\n.hbtn.solid:hover { background: var(--brand-d); }\n.hbtn .lbl { display: none; }\n.badge { position: absolute; top: -5px; inset-inline-end: -5px; min-width: 20px; height: 20px; border-radius: 10px; background: var(--gold); color: #fff; font-size: 11px; font-weight: 700; display: grid; place-items: center; padding-inline: 5px; border: 2px solid var(--bg); }\n.hsearch-m { display: none; padding-bottom: 10px; }\n.hsearch-m .search { display: block; }\n\n/* البانر */\n.banners { margin-top: 18px; position: relative; border-radius: 22px; overflow: hidden; aspect-ratio: 16 / 5; background: var(--line); touch-action: pan-y; }\n.bslide { position: absolute; inset: 0; opacity: 0; transition: opacity .6s; pointer-events: none; display: block; }\n.bslide.on { opacity: 1; pointer-events: auto; }\n.bslide img { width: 100%; height: 100%; object-fit: cover; display: block; }\n.dots { position: absolute; bottom: 10px; inset-inline: 0; display: flex; justify-content: center; gap: 6px; }\n.dots button { width: 7px; height: 7px; border-radius: 99px; border: 0; padding: 0; background: rgba(255,255,255,.55); box-shadow: 0 0 0 1px rgba(0,0,0,.12); transition: width .2s, background .2s; }\n.dots button[aria-current] { width: 22px; background: #fff; }\n\n/* المنتجات */\n.section { margin-top: 28px; }\n.sec-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }\n.sec-head h2 { font-size: 24px; }\n.sec-head p { color: var(--ink2); font-size: 13px; }\n.sort { height: 40px; border: 1px solid var(--line2); border-radius: 99px; background: var(--surface); padding-inline: 14px; font-size: 14px; }\n.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(236px, 1fr)); gap: 18px; }\n.card { background: var(--surface); border: 1px solid var(--line); border-radius: 20px; overflow: hidden; display: flex; flex-direction: column; transition: transform .2s, box-shadow .2s, border-color .2s; position: relative; }\n.card:hover { transform: translateY(-3px); box-shadow: 0 14px 34px rgba(80,30,30,.1); border-color: var(--line2); }\n.card > a.cover { position: absolute; inset: 0; z-index: 2; }\n.thumb { aspect-ratio: 4 / 3; display: grid; place-items: center; position: relative; background: linear-gradient(150deg, var(--c), color-mix(in srgb, var(--c) 60%, #000)); color: var(--ink-on, #fff); overflow: hidden; }\n.thumb img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }\n.thumb .gl { font-family: 'Reem Kufi', sans-serif; font-size: 52px; font-weight: 700; direction: ltr; text-shadow: 0 4px 14px rgba(0,0,0,.18); }\n.thumb.sold img { filter: grayscale(.8) opacity(.7); }\n.tag { position: absolute; top: 10px; inset-inline-start: 10px; z-index: 1; background: var(--surface); color: var(--bad); font-size: 12px; font-weight: 600; padding: 2px 11px; border-radius: 99px; }\n.card .body { padding: 14px 16px 16px; display: grid; gap: 4px; }\n.card h3 { font-size: 18px; font-family: 'IBM Plex Sans Arabic', sans-serif; font-weight: 700; }\n.card .desc { color: var(--ink2); font-size: 13px; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }\n.card .foot { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-top: 8px; }\n.price { font-weight: 700; font-size: 20px; color: var(--brand); }\n.price small { font-weight: 400; font-size: 12px; color: var(--ink3); margin-inline-end: 6px; }\n.go { color: var(--brand-d); font-weight: 600; font-size: 13.5px; }\n.empty { background: var(--surface); border: 1px dashed var(--line2); border-radius: var(--r); padding: 44px 16px; text-align: center; color: var(--ink2); display: grid; gap: 12px; justify-items: center; }\n\n/* أزرار */\n.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 48px; padding-inline: 24px; border-radius: 99px; border: 1.5px solid var(--brand); background: var(--brand); color: #fff; font-weight: 600; font-size: 15px; transition: background .15s, transform .05s; }\n.btn:hover { background: var(--brand-d); border-color: var(--brand-d); }\n.btn:active { transform: scale(.98); }\n.btn:disabled { opacity: .55; cursor: not-allowed; }\n.btn.ghost { background: transparent; color: var(--brand); }\n.btn.ghost:hover { background: var(--brand-l); }\n.btn.block { width: 100%; }\n.btn.sm { height: 38px; padding-inline: 16px; font-size: 13.5px; }\n.linkbtn { background: none; border: 0; color: var(--brand); font-weight: 600; padding: 6px; }\n\n/* صفحة المنتج */\n.crumbs { display: flex; gap: 8px; align-items: center; color: var(--ink2); font-size: 13px; margin-top: 18px; }\n.crumbs a:hover { color: var(--brand); }\n.pdp { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 28px; margin-top: 14px; align-items: start; }\n.pdp .thumb { border-radius: 24px; aspect-ratio: 1; border: 1px solid var(--line); }\n.pdp .thumb .gl { font-size: 96px; }\n.panel { display: grid; gap: 18px; }\n.pdp h1 { font-size: 34px; }\n.pdp .d { color: var(--ink2); font-size: 16px; }\n.lbl2 { font-weight: 600; font-size: 14px; color: var(--ink2); }\n.plans { display: grid; gap: 10px; margin-top: 8px; }\n.plan { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border: 1.5px solid var(--line2); border-radius: 16px; background: var(--surface); text-align: start; width: 100%; transition: border-color .15s, background .15s; }\n.plan:hover { border-color: var(--brand); }\n.plan[aria-checked=true] { border-color: var(--brand); background: var(--brand-l); }\n.plan .rd { width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--line2); display: grid; place-items: center; flex: none; }\n.plan[aria-checked=true] .rd { border-color: var(--brand); }\n.plan[aria-checked=true] .rd::after { content: ''; width: 10px; height: 10px; border-radius: 50%; background: var(--brand); }\n.plan .nm { flex: 1; font-weight: 600; }\n.plan .pr { font-weight: 700; font-size: 18px; color: var(--brand); }\n.plan[disabled] { opacity: .5; cursor: not-allowed; }\n.actions { display: grid; grid-template-columns: 1.4fr 1fr; gap: 10px; }\n.note { color: var(--ink2); font-size: 13px; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 10px 14px; display: flex; gap: 10px; align-items: center; }\n.note .ico { color: var(--brand); width: 20px; height: 20px; }\n\n/* الدرج والنوافذ */\n#overlay { position: fixed; inset: 0; z-index: 60; background: rgba(42,20,24,.5); display: flex; animation: fade .18s; }\n#overlay[hidden] { display: none; }\n@keyframes fade { from { opacity: 0; } }\n.drawer { width: min(440px, 100%); background: var(--bg); height: 100%; display: flex; flex-direction: column; margin-inline-start: auto; animation: slide .22s ease-out; }\n@keyframes slide { from { transform: translateX(-40px); opacity: 0; } }\n.modal { margin: auto; width: min(460px, calc(100% - 24px)); max-height: calc(100% - 24px); overflow: auto; background: var(--surface); border-radius: 24px; padding: 26px; animation: pop .2s ease-out; position: relative; }\n@keyframes pop { from { transform: scale(.96) translateY(8px); opacity: 0; } }\n.mhead { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--line); }\n.mhead h2 { font-size: 20px; }\n.x { width: 38px; height: 38px; border: 0; background: var(--line); border-radius: 50%; display: grid; place-items: center; }\n.modal .x { position: absolute; top: 14px; inset-inline-end: 14px; }\n.dbody { flex: 1; overflow: auto; padding: 16px 20px; display: grid; gap: 12px; align-content: start; }\n.dfoot { border-top: 1px solid var(--line); padding: 16px 20px calc(16px + env(safe-area-inset-bottom, 0px)); display: grid; gap: 10px; background: var(--surface); }\n.line { display: flex; gap: 12px; align-items: center; padding: 10px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); }\n.line .thumb { width: 60px; aspect-ratio: 1; border-radius: 12px; flex: none; }\n.line .thumb .gl { font-size: 22px; }\n.line .grow { flex: 1; min-width: 0; }\n.line .grow b { display: block; }\n.line .grow span { color: var(--ink2); font-size: 13px; }\n.rm { border: 0; background: none; color: var(--ink3); padding: 8px; border-radius: 8px; }\n.rm:hover { color: var(--bad); background: var(--bad-bg); }\n.sum { display: flex; justify-content: space-between; align-items: center; }\n.sum.big { font-size: 19px; font-weight: 700; }\n.sum.big b { color: var(--brand); }\n.warnbox { background: var(--warn-bg); color: var(--warn); border-radius: 14px; padding: 10px 14px; font-size: 13.5px; }\n.okbox { background: var(--ok-bg); color: var(--ok); border-radius: 14px; padding: 10px 14px; font-size: 13.5px; }\n.pays { display: flex; gap: 8px; align-items: center; justify-content: center; color: var(--ink2); font-size: 12.5px; }\n\n/* النماذج */\n.form { display: grid; gap: 14px; margin-top: 14px; }\n.field { display: grid; gap: 6px; font-weight: 500; font-size: 14px; }\n.field input { height: 50px; border: 1.5px solid var(--line2); border-radius: 14px; padding-inline: 16px; outline: none; background: var(--bg); font-weight: 400; }\n.field input:focus { border-color: var(--brand); background: #fff; }\n.err { color: var(--bad); font-size: 13.5px; }\n.err:empty { display: none; }\n.auth h2 { font-size: 24px; }\n.auth .sub { color: var(--ink2); margin-top: 4px; font-size: 14px; }\n.tabs { display: flex; gap: 6px; background: var(--line); padding: 4px; border-radius: 99px; }\n.tabs button { flex: 1; height: 38px; border: 0; background: none; border-radius: 99px; font-weight: 600; color: var(--ink2); }\n.tabs button[aria-current] { background: var(--surface); color: var(--brand); box-shadow: 0 1px 3px rgba(42,20,24,.12); }\n\n/* الحساب */\n.acct { max-width: 760px; margin: 22px auto 0; display: grid; gap: 14px; }\n.who { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }\n.who h1 { font-size: 26px; }\n.rows { display: grid; gap: 10px; }\n.row { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 14px 16px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); text-align: start; width: 100%; }\nbutton.row:hover { border-color: var(--brand); }\n.row .t { font-weight: 600; }\n.row .m { color: var(--ink2); font-size: 12.5px; }\n.amt { font-weight: 700; }\n.pill { display: inline-block; padding: 2px 12px; border-radius: 99px; font-size: 12px; font-weight: 600; background: var(--line); color: var(--ink2); }\n.pill.ok { background: var(--ok-bg); color: var(--ok); }\n.pill.warn { background: var(--warn-bg); color: var(--warn); }\n.code { background: var(--ink); color: #f3e9e4; border-radius: 16px; padding: 14px; display: grid; gap: 10px; }\n.code pre { margin: 0; white-space: pre-wrap; word-break: break-all; direction: ltr; text-align: left; font: 500 14px/1.7 ui-monospace, Menlo, monospace; }\n.code .btn { background: #f3e9e4; color: var(--ink); border-color: #f3e9e4; }\n.page { background: var(--surface); border: 1px solid var(--line); border-radius: 22px; padding: clamp(20px, 4vw, 36px); margin-top: 18px; max-width: 820px; }\n.page h1 { font-size: 28px; margin-bottom: 14px; }\n.page h3 { margin: 18px 0 6px; font-size: 18px; }\n.page p, .page li { color: var(--ink2); }\n.page ul { padding-inline-start: 20px; }\n.faq { display: grid; gap: 10px; margin-top: 14px; }\n.faq details { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 0 18px; }\n.faq summary { cursor: pointer; font-weight: 600; padding: 15px 0; list-style: none; display: flex; justify-content: space-between; gap: 12px; }\n.faq summary::-webkit-details-marker { display: none; }\n.faq summary::after { content: '+'; font-size: 20px; color: var(--brand); line-height: 1.3; }\n.faq details[open] summary::after { content: '−'; }\n.faq p { color: var(--ink2); padding-bottom: 16px; }\n\n/* الفوتر */\n.footer { margin-top: 56px; border-top: 1px solid var(--line2); background: var(--surface); padding-top: 30px; }\n.fgrid { display: grid; grid-template-columns: 1.5fr 1fr 1fr; gap: 28px; align-items: start; }\n.footer .logo img { height: 52px; }\n.footer p { color: var(--ink2); font-size: 13.5px; margin-top: 10px; max-width: 330px; }\n.footer h4 { margin: 0 0 10px; font-size: 15px; }\n.footer ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 7px; font-size: 14px; color: var(--ink2); }\n.footer a:hover { color: var(--brand); }\n.pay { display: flex; gap: 8px; flex-wrap: wrap; direction: ltr; justify-content: flex-end; }\n.pay span { height: 36px; min-width: 78px; padding-inline: 14px; border-radius: 10px; border: 1px solid var(--line2); background: var(--bg); display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; color: var(--ink); }\n.pay span:first-child { font-style: italic; letter-spacing: .02em; color: #1a2370; }\n.fbar { border-top: 1px solid var(--line); margin-top: 26px; padding-block: 14px calc(14px + env(safe-area-inset-bottom, 0px)); display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-size: 13px; color: var(--ink3); }\n\n#toast { position: fixed; z-index: 90; bottom: calc(24px + env(safe-area-inset-bottom, 0px)); inset-inline: 0; margin-inline: auto; width: fit-content; max-width: calc(100% - 32px); background: var(--ink); color: #fff; padding: 11px 20px; border-radius: 99px; font-size: 14px; opacity: 0; transform: translateY(12px); pointer-events: none; transition: .2s; box-shadow: 0 8px 28px rgba(0,0,0,.25); }\n#toast.show { opacity: 1; transform: none; }\n#toast.err { background: var(--bad); }\n\n@media (min-width: 900px) { .hbtn .lbl { display: inline; } }\n@media (max-width: 860px) { .fgrid { grid-template-columns: 1fr 1fr; } .fgrid > :first-child { grid-column: 1 / -1; } .pay { justify-content: flex-start; } }\n@media (max-width: 720px) {\n  .pdp { grid-template-columns: 1fr; }\n  .pdp .thumb { aspect-ratio: 4 / 3; }\n  .pdp h1 { font-size: 28px; }\n  .hrow .search { display: none; }\n  .hsearch-m { display: block; }\n  .hsearch-m .search { max-width: none; }\n  .banners { aspect-ratio: 2 / 1; border-radius: 18px; margin-top: 12px; }\n  .grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }\n  .card { border-radius: 16px; }\n  .card .body { padding: 10px 12px 12px; }\n  .card h3 { font-size: 15px; }\n  .card .desc { display: none; }\n  .thumb .gl { font-size: 38px; }\n  .price { font-size: 17px; }\n  .price small { display: block; margin: 0; }\n  .go { display: none; }\n  .sec-head h2 { font-size: 20px; }\n  .actions { grid-template-columns: 1fr; }\n  .fgrid { grid-template-columns: 1fr; }\n  .logo img { height: 40px; }\n  .modal { padding: 22px; }\n}\n@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } html { scroll-behavior: auto; } }\n"},"/app.js":{"type":"text/javascript; charset=utf-8","body":"'use strict';\nconst SITE = { name: 'MO7', year: new Date().getFullYear() };\n\nconst $ = (s, r = document) => r.querySelector(s);\nconst app = $('#app');\nconst overlay = $('#overlay');\n\nconst store = {\n  get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },\n  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },\n};\nlet token = store.get('tok');\nlet cart = (() => { try { return JSON.parse(store.get('cart') || '[]').filter(Number.isInteger); } catch { return []; } })();\n\nconst S = {\n  loaded: false, guest: true, products: [], banners: [], site: { announce: '' }, config: { support: '', web: true },\n  me: { balance: 0, name: '' }, orders: [],\n  q: '', sort: 'def', busy: false, slide: 0, pdpPlan: null, modal: null, afterAuth: null, authMode: 'signup', authNote: '', prompted: false,\n};\n\n/* ───────── أدوات ───────── */\nconst esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' })[c]);\nconst usd = (c) => `$${c % 100 === 0 ? c / 100 : (c / 100).toFixed(2)}`;\nconst usd2 = (c) => `$${(c / 100).toFixed(2)}`;\nconst fmtDate = (t) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(t * 1000));\nconst lum = (hex) => { const n = parseInt(String(hex).slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };\nconst inkOn = (hex) => (lum(hex) > 0.62 ? '#14112b' : '#ffffff');\nconst safeUrl = (u) => (/^(https?:\\/\\/|#\\/|\\/)/.test(u || '') ? u : '');\n\nconst ICONS = {\n  search: '<circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"m20 20-3.5-3.5\"/>',\n  cart: '<path d=\"M3 4h2l2.4 11.2a1.5 1.5 0 0 0 1.5 1.2h8.2a1.5 1.5 0 0 0 1.5-1.1L20.5 8H6.2\"/><circle cx=\"9.5\" cy=\"20\" r=\"1.3\"/><circle cx=\"17\" cy=\"20\" r=\"1.3\"/>',\n  user: '<circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4.5 20.5a7.5 7.5 0 0 1 15 0\"/>',\n  x: '<path d=\"M6 6l12 12M18 6 6 18\"/>',\n  card: '<rect x=\"3\" y=\"5.5\" width=\"18\" height=\"13\" rx=\"2.5\"/><path d=\"M3 10h18M7 15h4\"/>',\n  trash: '<path d=\"M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13\"/>',\n  lock: '<rect x=\"5\" y=\"11\" width=\"14\" height=\"9\" rx=\"2\"/><path d=\"M8 11V8a4 4 0 0 1 8 0v3\"/>',\n  check: '<path d=\"m5 12.5 4.5 4.5L19 7.5\"/>',\n};\nconst ico = (n) => `<svg class=\"ico\" viewBox=\"0 0 24 24\" aria-hidden=\"true\">${ICONS[n] || ''}</svg>`;\n\nlet toastTimer;\nfunction toast(msg, err = false) {\n  const el = $('#toast');\n  el.textContent = msg; el.className = `show${err ? ' err' : ''}`;\n  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.className = ''), 3600);\n}\n\nasync function api(path, body) {\n  const headers = { 'content-type': 'application/json' };\n  if (token) headers.authorization = `Bearer ${token}`;\n  let r;\n  try { r = await fetch(`/api${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined }); }\n  catch { throw Object.assign(new Error('تعذّر الاتصال. تحقق من الإنترنت وحاول مرة أخرى'), { status: 0 }); }\n  const j = await r.json().catch(() => ({}));\n  if (!r.ok) throw Object.assign(new Error(j.error || 'تعذّر إكمال الطلب. حاول مرة أخرى'), { status: r.status });\n  return j;\n}\n\nconst saveCart = () => store.set('cart', JSON.stringify(cart));\nconst GUEST = { me: { balance: 0, name: '' }, orders: [] };\n\nasync function refresh() {\n  try {\n    if (!token) Object.assign(S, await api('/catalog'), GUEST, { loaded: true, guest: true });\n    else Object.assign(S, await api('/state'), { loaded: true, guest: false });\n  } catch (e) {\n    if (token && e.status === 401) { token = ''; store.set('tok', ''); return refresh(); }\n    throw e;\n  }\n  cleanCart();\n  render();\n}\n\n/* ───────── بيانات مشتقة ───────── */\nconst product = (id) => S.products.find((p) => p.id === id);\nconst hasStock = (p) => p.plans.some((x) => x.available);\nconst minPrice = (p) => Math.min(...p.plans.filter((x) => x.available).map((x) => x.price));\nfunction findPlan(planId) {\n  for (const p of S.products) { const pl = p.plans.find((x) => x.id === planId); if (pl) return { p, pl }; }\n  return null;\n}\nfunction cleanCart() {\n  const before = cart.length;\n  cart = cart.filter((id, i) => { const f = findPlan(id); return f && f.pl.available && cart.indexOf(id) === i; });\n  if (cart.length !== before) saveCart();\n}\nconst cartItems = () => cart.map(findPlan).filter(Boolean);\nconst cartTotal = () => cartItems().reduce((s, x) => s + x.pl.price, 0);\n\n/* ───────── المكوّنات ───────── */\nconst thumb = (p, extra = '') => `<div class=\"thumb ${extra}\" style=\"--c:${esc(p.color)};--ink-on:${inkOn(p.color)}\">${p.img ? `<img src=\"${esc(p.img)}\" alt=\"${esc(p.name)}\" loading=\"lazy\">` : `<span class=\"gl\">${esc(p.glyph)}</span>`}</div>`;\n\nfunction header() {\n  const q = esc(S.q);\n  const search = (attr) => `<form class=\"search\" role=\"search\" data-form=\"search\" ${attr}>${ico('search')}<input type=\"search\" data-q value=\"${q}\" placeholder=\"ابحث عن اشتراك…\" autocomplete=\"off\" aria-label=\"بحث\"></form>`;\n  return `${S.site.announce ? `<div class=\"announce\">${esc(S.site.announce)}</div>` : ''}\n  <header class=\"header\"><div class=\"wrap\">\n    <div class=\"hrow\">\n      <a class=\"logo\" href=\"#/\" aria-label=\"${SITE.name}\"><img src=\"/logo.webp\" alt=\"${SITE.name}\" width=\"92\" height=\"46\"></a>\n      ${search('')}\n      <div class=\"hact\">\n        ${S.guest\n          ? `<button class=\"hbtn\" data-act=\"login\" aria-label=\"تسجيل الدخول\">${ico('user')}<span class=\"lbl\">دخول</span></button>`\n          : `<a class=\"hbtn\" href=\"#/account\" aria-label=\"حسابي وطلباتي\">${ico('user')}<span class=\"lbl\">طلباتي</span></a>`}\n        <button class=\"hbtn solid\" data-act=\"cart\" aria-label=\"السلة\">${ico('cart')}<span class=\"lbl\">السلة</span>${cart.length ? `<span class=\"badge\">${cart.length}</span>` : ''}</button>\n      </div>\n    </div>\n    <div class=\"hsearch-m\">${search('')}</div>\n  </div></header>`;\n}\n\nfunction banners() {\n  if (!S.banners.length || S.q.trim()) return '';\n  const one = S.banners.length === 1;\n  return `<section class=\"banners\" aria-roledescription=\"carousel\" aria-label=\"عروض\">\n    ${S.banners.map((b, i) => {\n      const link = safeUrl(b.link);\n      const img = `<img src=\"${esc(b.img)}\" alt=\"\" ${i === 0 ? '' : 'loading=\"lazy\"'}>`;\n      const cls = `bslide ${i === S.slide ? 'on' : ''}`;\n      return link ? `<a class=\"${cls}\" href=\"${esc(link)}\" ${/^https?:/.test(link) ? 'target=\"_blank\" rel=\"noopener\"' : ''} ${i === S.slide ? '' : 'tabindex=\"-1\"'}>${img}</a>` : `<div class=\"${cls}\">${img}</div>`;\n    }).join('')}\n    ${one ? '' : `<div class=\"dots\">${S.banners.map((_, i) => `<button data-act=\"slide\" data-i=\"${i}\" aria-label=\"شريحة ${i + 1}\" ${i === S.slide ? 'aria-current=\"true\"' : ''}></button>`).join('')}</div>`}\n  </section>`;\n}\n\nfunction card(p) {\n  const ok = hasStock(p);\n  return `<article class=\"card\">\n    <a class=\"cover\" href=\"#/p/${p.id}\" aria-label=\"${esc(p.name)}\"></a>\n    <div style=\"position:relative\">${thumb(p, ok ? '' : 'sold')}${ok ? '' : '<span class=\"tag\">غير متوفر</span>'}</div>\n    <div class=\"body\">\n      <h3><bdi>${esc(p.name)}</bdi></h3>\n      <p class=\"desc\">${esc(p.desc)}</p>\n      <div class=\"foot\">${ok ? `<div class=\"price\"><small>يبدأ من</small><bdi>${usd(minPrice(p))}</bdi></div><span class=\"go\">عرض الباقات ←</span>` : '<span style=\"color:var(--ink3);font-size:13px\">نفدت الكمية</span>'}</div>\n    </div></article>`;\n}\n\nfunction filtered() {\n  const q = S.q.trim().toLowerCase();\n  let list = S.products.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.desc || '').toLowerCase().includes(q));\n  if (S.sort === 'low') list = [...list].sort((a, b) => (hasStock(a) ? minPrice(a) : 1e9) - (hasStock(b) ? minPrice(b) : 1e9));\n  if (S.sort === 'high') list = [...list].sort((a, b) => (hasStock(b) ? minPrice(b) : -1) - (hasStock(a) ? minPrice(a) : -1));\n  return list;\n}\n\nfunction homePage() {\n  const list = filtered();\n  const title = S.q.trim() ? `نتائج البحث عن «${S.q.trim()}»` : 'المنتجات';\n  return `<div class=\"wrap\">${banners()}\n    <section class=\"section\" id=\"products\">\n      <div class=\"sec-head\"><div><h2>${esc(title)}</h2><p>${list.length} ${list.length === 1 ? 'منتج' : 'منتجات'}</p></div>\n        <select class=\"sort\" data-sort aria-label=\"ترتيب\"><option value=\"def\" ${S.sort === 'def' ? 'selected' : ''}>الافتراضي</option><option value=\"low\" ${S.sort === 'low' ? 'selected' : ''}>الأقل سعرًا</option><option value=\"high\" ${S.sort === 'high' ? 'selected' : ''}>الأعلى سعرًا</option></select></div>\n      ${list.length ? `<div class=\"grid\">${list.map(card).join('')}</div>` : `<div class=\"empty\"><p>${S.q ? 'ما لقينا منتجًا مطابقًا لبحثك.' : 'لا توجد منتجات حاليًا.'}</p>${S.q ? '<button class=\"btn sm ghost\" data-act=\"clearq\">مسح البحث</button>' : ''}</div>`}\n    </section></div>`;\n}\n\nfunction pdpPage(id) {\n  const p = product(id);\n  if (!p) return notFound();\n  const avail = p.plans.filter((x) => x.available);\n  if (!avail.find((x) => x.id === S.pdpPlan)) S.pdpPlan = avail[0]?.id ?? null;\n  const sel = p.plans.find((x) => x.id === S.pdpPlan);\n  return `<div class=\"wrap\">\n    <div class=\"crumbs\"><a href=\"#/\">المنتجات</a><span>›</span><bdi>${esc(p.name)}</bdi></div>\n    <div class=\"pdp\">\n      ${thumb(p)}\n      <div class=\"panel\">\n        <div><h1><bdi>${esc(p.name)}</bdi></h1>${p.desc ? `<p class=\"d\" style=\"margin-top:6px\">${esc(p.desc)}</p>` : ''}</div>\n        ${avail.length ? `<div><div class=\"lbl2\">اختر الباقة</div><div class=\"plans\" role=\"radiogroup\" aria-label=\"الباقات\">\n          ${p.plans.map((pl) => `<button class=\"plan\" role=\"radio\" aria-checked=\"${pl.id === S.pdpPlan}\" data-act=\"plan\" data-id=\"${pl.id}\" ${pl.available ? '' : 'disabled'}><span class=\"rd\"></span><span class=\"nm\">${esc(pl.label)}${pl.available ? '' : ' (غير متوفرة)'}</span><span class=\"pr\"><bdi>${usd(pl.price)}</bdi></span></button>`).join('')}</div></div>\n          <div class=\"actions\"><button class=\"btn\" data-act=\"buynow\" data-id=\"${sel.id}\" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class=\"spin\"></span>' : `${ico('card')} اشترِ الآن`}</button><button class=\"btn ghost\" data-act=\"add\" data-id=\"${sel.id}\">أضف للسلة</button></div>`\n          : '<div class=\"warnbox\">هذه الخدمة غير متوفرة حاليًا. جرّب لاحقًا.</div>'}\n        <div class=\"note\">${ico('lock')}<span>الدفع بالبطاقة (Visa / Mastercard) في صفحة دفع آمنة. تظهر بيانات اشتراكك في «طلباتي» بعد الدفع.</span></div>\n      </div>\n    </div></div>`;\n}\n\nconst FAQ = [\n  ['كيف أشتري؟', 'اختر المنتج والباقة ثم اضغط «اشترِ الآن» أو أضفها للسلة. تحتاج حسابًا عند الدفع فقط، ثم تُحوَّل لصفحة دفع آمنة بالبطاقة.'],\n  ['ما وسائل الدفع؟', 'حاليًا البطاقات البنكية Visa وMastercard.'],\n  ['متى أستلم اشتراكي؟', 'بعد نجاح الدفع تظهر بيانات الاشتراك في «طلباتي». بعض الطلبات تُجهَّز يدويًا فتبقى «قيد التجهيز» حتى نسلّمها لك.'],\n  ['ماذا لو واجهت مشكلة؟', 'تواصل معنا مع رقم طلبك وسنتابع المشكلة. وإن تعذّر التسليم نعيد المبلغ.'],\n  ['هل أستطيع استعادة كلمة المرور؟', 'لا تتوفر الاستعادة التلقائية حاليًا، فاحفظ كلمة مرورك. إن نسيتها تواصل معنا.'],\n];\nconst faqPage = () => `<div class=\"wrap\"><div class=\"page\"><h1>الأسئلة الشائعة</h1><div class=\"faq\">${FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div></div></div>`;\n\nconst PAGES = {\n  terms: ['الشروط والأحكام', `<p>باستخدامك هذا المتجر فإنك توافق على الشروط التالية.</p><h3>الطلبات</h3><p>الأسعار بالدولار الأمريكي وقد تتغير دون إشعار، ويُعتمد السعر وقت الدفع.</p><h3>التسليم</h3><p>تُسلَّم بيانات الاشتراك في صفحة «طلباتي». الطلبات اليدوية تبقى «قيد التجهيز» حتى نسلّمها.</p><h3>حسابك</h3><ul><li>أنت مسؤول عن سرّية بريدك وكلمة مرورك.</li><li>لا يجوز إعادة بيع بيانات الاشتراكات إلا بإذن مسبق.</li><li>يحق لنا إيقاف أي حساب يُساء استخدامه.</li></ul>`],\n  refund: ['سياسة الاسترجاع', `<p>لأن المنتجات رقمية وتُسلَّم فورًا، فالاسترجاع محدود بالحالات التالية:</p><ul><li>تعذّر التسليم أو عدم توفر الاشتراك: يُعاد المبلغ.</li><li>اشتراك لا يعمل عند الاستلام: تواصل معنا برقم الطلب لنعالج المشكلة أو نعيد المبلغ.</li><li>بعد استخدام الاشتراك بنجاح لا يمكن استرجاعه.</li></ul>`],\n  privacy: ['سياسة الخصوصية', `<p>نحترم خصوصيتك ونجمع أقل قدر من البيانات.</p><ul><li>نحفظ بريدك واسمك وسجل طلباتك لتشغيل حسابك.</li><li>كلمات المرور تُخزَّن مشفّرة ولا يمكننا قراءتها.</li><li>الدفع بالبطاقة يتم عبر بوابة دفع خارجية، ولا نخزّن بيانات بطاقتك.</li><li>لا نبيع بياناتك لأي طرف.</li></ul>`],\n};\nconst staticPage = (key) => (PAGES[key] ? `<div class=\"wrap\"><div class=\"page\"><h1>${PAGES[key][0]}</h1>${PAGES[key][1]}</div></div>` : notFound());\nconst notFound = () => `<div class=\"wrap\"><div class=\"empty\" style=\"margin-top:24px\"><h2>الصفحة غير موجودة</h2><a class=\"btn sm\" href=\"#/\">العودة للمنتجات</a></div></div>`;\n\nconst STATUS = { delivered: ['تم التسليم', 'ok'], pending: ['قيد التجهيز', 'warn'], paid: ['قيد التجهيز', 'warn'], awaiting: ['بانتظار الدفع', ''], refunded: ['مسترد', ''] };\nconst pill = (s) => { const [t, c] = STATUS[s] || [s, '']; return `<span class=\"pill ${c}\">${t}</span>`; };\n\nfunction accountPage() {\n  if (S.guest) {\n    if (!S.modal && !S.prompted) { S.prompted = true; setTimeout(() => openAuth({ note: 'سجّل الدخول لعرض طلباتك.', mode: 'login' }), 0); }\n    return `<div class=\"wrap\"><div class=\"empty\" style=\"margin-top:24px\"><p>سجّل الدخول لعرض طلباتك.</p><button class=\"btn sm\" data-act=\"login\">تسجيل الدخول</button></div></div>`;\n  }\n  return `<div class=\"wrap\"><div class=\"acct\">\n    <div class=\"who\"><h1>طلباتي</h1><button class=\"btn sm ghost\" data-act=\"logout\">تسجيل الخروج</button></div>\n    ${S.me.balance > 0 ? `<div class=\"okbox\">لديك رصيد <bdi>${usd2(S.me.balance)}</bdi> في حسابك، يُخصم تلقائيًا من طلبك القادم.</div>` : ''}\n    ${S.orders.length ? `<div class=\"rows\">${S.orders.map((o) => `<button class=\"row\" data-act=\"order\" data-id=\"${o.id}\"><div><div class=\"t\"><bdi>${esc(o.product)}</bdi> · ${esc(o.plan)}</div><div class=\"m\">طلب #${o.id} · ${fmtDate(o.created)}</div></div><div style=\"text-align:end\">${pill(o.status)}<div class=\"amt\" style=\"font-size:14px;margin-top:2px\"><bdi>${usd2(o.price)}</bdi></div></div></button>`).join('')}</div>`\n      : '<div class=\"empty\"><p>لم تطلب شيئًا بعد.</p><a class=\"btn sm\" href=\"#/\">تصفّح المنتجات</a></div>'}\n  </div></div>`;\n}\n\nfunction footer() {\n  const sup = S.config.support ? `<li><a href=\"https://t.me/${esc(S.config.support)}\" target=\"_blank\" rel=\"noopener\">تواصل معنا</a></li>` : '';\n  return `<footer class=\"footer\"><div class=\"wrap\">\n    <div class=\"fgrid\">\n      <div><a class=\"logo\" href=\"#/\"><img src=\"/logo.webp\" alt=\"${SITE.name}\"></a><p>اشتراكات رقمية بأسعار واضحة. ادفع بالبطاقة واستلم اشتراكك في صفحة طلباتك.</p></div>\n      <div><h4>المساعدة</h4><ul><li><a href=\"#/faq\">الأسئلة الشائعة</a></li><li><a href=\"#/page/terms\">الشروط والأحكام</a></li><li><a href=\"#/page/refund\">سياسة الاسترجاع</a></li><li><a href=\"#/page/privacy\">سياسة الخصوصية</a></li>${sup}</ul></div>\n      <div><h4>بوابة الدفع</h4><div class=\"pay\" aria-label=\"وسائل الدفع المقبولة\"><span>VISA</span><span>Mastercard</span></div></div>\n    </div>\n    <div class=\"fbar\"><span>© ${SITE.year} ${SITE.name}. جميع الحقوق محفوظة.</span><span>الأسعار بالدولار الأمريكي (USD)</span></div>\n  </div></footer>`;\n}\n\n/* ───────── التوجيه والعرض ───────── */\nfunction parseRoute() {\n  const [a, b] = (location.hash || '#/').replace(/^#\\/?/, '').split('/');\n  if (!a) return { name: 'home' };\n  if (a === 'p') return { name: 'pdp', arg: Number(b) };\n  if (a === 'account') return { name: 'account' };\n  if (a === 'page') return { name: 'page', arg: b };\n  if (a === 'faq') return { name: 'faq' };\n  return { name: 'home' };\n}\n\nfunction render() {\n  if (!S.loaded) { app.innerHTML = '<div class=\"boot\"><span class=\"spin\"></span></div>'; return; }\n  const r = parseRoute();\n  const main = { home: homePage, pdp: () => pdpPage(r.arg), account: accountPage, page: () => staticPage(r.arg), faq: faqPage }[r.name]();\n  const hadFocus = document.activeElement?.matches?.('input[type=search]');\n  app.innerHTML = `${header()}<main id=\"main\">${main}</main>${footer()}`;\n  if (hadFocus) { const el = [...document.querySelectorAll('.header input[type=search]')].find((i) => i.offsetParent !== null); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }\n  if (S.modal) renderModal();\n}\nwindow.addEventListener('hashchange', () => { S.prompted = false; closeOverlay(); render(); window.scrollTo(0, 0); });\n\n/* ───────── النوافذ ───────── */\nfunction showOverlay(html) { overlay.hidden = false; overlay.innerHTML = html; document.body.style.overflow = 'hidden'; }\nfunction closeOverlay() { overlay.hidden = true; overlay.innerHTML = ''; S.modal = null; document.body.style.overflow = ''; }\nfunction renderModal() {\n  const m = S.modal;\n  if (!m) return;\n  if (m.type === 'cart') showOverlay(cartHtml());\n  else if (m.type === 'auth') showOverlay(authHtml());\n  else if (m.type === 'order') showOverlay(orderHtml(m.id));\n  else if (m.type === 'result') showOverlay(resultHtml(m));\n}\nfunction openModal(m) { S.modal = m; renderModal(); }\n\nfunction cartHtml() {\n  const items = cartItems();\n  const total = cartTotal();\n  const credit = S.guest ? 0 : Math.min(S.me.balance, total);\n  const due = total - credit;\n  return `<aside class=\"drawer\" role=\"dialog\" aria-modal=\"true\" aria-label=\"السلة\">\n    <div class=\"mhead\"><h2>السلة (${items.length})</h2><button class=\"x\" data-act=\"close\" aria-label=\"إغلاق\">${ico('x')}</button></div>\n    <div class=\"dbody\">${items.length ? items.map(({ p, pl }) => `<div class=\"line\">${thumb(p)}<div class=\"grow\"><b><bdi>${esc(p.name)}</bdi></b><span>${esc(pl.label)}</span></div><b><bdi>${usd(pl.price)}</bdi></b><button class=\"rm\" data-act=\"rm\" data-id=\"${pl.id}\" aria-label=\"حذف\">${ico('trash')}</button></div>`).join('')\n      : `<div class=\"empty\"><p>سلتك فارغة.</p><button class=\"btn sm\" data-act=\"close\">تصفّح المنتجات</button></div>`}</div>\n    ${items.length ? `<div class=\"dfoot\">\n      ${credit > 0 ? `<div class=\"sum\"><span>رصيدك المتاح</span><span>− <bdi>${usd2(credit)}</bdi></span></div>` : ''}\n      <div class=\"sum big\"><span>${credit > 0 ? 'المطلوب دفعه' : 'المجموع'}</span><b><bdi>${usd2(Math.max(due, 0))}</bdi></b></div>\n      ${S.guest ? '<div class=\"note\">ستنشئ حسابًا أو تسجّل الدخول عند الدفع. سلتك محفوظة.</div>' : ''}\n      <button class=\"btn block\" data-act=\"checkout\" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class=\"spin\"></span>' : `${ico('card')} ${due > 0 || S.guest ? 'الدفع بالبطاقة' : 'إتمام الطلب'}`}</button>\n      <div class=\"pays\">${ico('lock')}<span>دفع آمن · Visa · Mastercard</span></div>\n    </div>` : ''}\n  </aside>`;\n}\n\nfunction authHtml() {\n  const su = S.authMode === 'signup';\n  return `<div class=\"modal auth\" role=\"dialog\" aria-modal=\"true\" aria-label=\"الحساب\">\n    <button class=\"x\" data-act=\"close\" aria-label=\"إغلاق\">${ico('x')}</button>\n    <h2>${su ? 'أنشئ حسابك' : 'أهلًا بعودتك'}</h2>\n    <p class=\"sub\">${esc(S.authNote) || (su ? 'حساب واحد لطلباتك واشتراكاتك.' : 'سجّل الدخول لمتابعة طلباتك.')}</p>\n    <div class=\"tabs\" style=\"margin-top:14px\"><button data-act=\"authmode\" data-m=\"signup\" ${su ? 'aria-current=\"true\"' : ''}>حساب جديد</button><button data-act=\"authmode\" data-m=\"login\" ${su ? '' : 'aria-current=\"true\"'}>تسجيل الدخول</button></div>\n    <form id=\"authform\" class=\"form\" novalidate>\n      ${su ? '<label class=\"field\"><span>الاسم</span><input name=\"name\" autocomplete=\"name\" maxlength=\"40\"></label>' : ''}\n      <label class=\"field\"><span>البريد الإلكتروني</span><input name=\"email\" type=\"email\" inputmode=\"email\" autocomplete=\"email\" dir=\"ltr\" required></label>\n      <label class=\"field\"><span>كلمة المرور</span><input name=\"password\" type=\"password\" autocomplete=\"${su ? 'new-password' : 'current-password'}\" dir=\"ltr\" required minlength=\"8\"></label>\n      ${su ? '<p class=\"note\">8 أحرف على الأقل. لا نستطيع استعادة كلمة المرور تلقائيًا، فاحفظها في مكان آمن.</p>' : ''}\n      <div id=\"autherr\" class=\"err\" role=\"alert\"></div>\n      <button class=\"btn block\" type=\"submit\">${su ? 'إنشاء الحساب' : 'تسجيل الدخول'}</button>\n    </form></div>`;\n}\nfunction openAuth({ note = '', mode = 'signup', after = null } = {}) {\n  S.authNote = note; S.authMode = mode; S.afterAuth = after;\n  openModal({ type: 'auth' });\n  setTimeout(() => $('#authform input')?.focus(), 50);\n}\n\nfunction orderHtml(id) {\n  const o = S.orders.find((x) => x.id === id);\n  if (!o) return '';\n  return `<div class=\"modal\" role=\"dialog\" aria-modal=\"true\" aria-label=\"تفاصيل الطلب\">\n    <button class=\"x\" data-act=\"close\" aria-label=\"إغلاق\">${ico('x')}</button>\n    <h2 style=\"font-size:22px;margin-bottom:4px\">طلب #${o.id}</h2>\n    <p style=\"color:var(--ink2)\"><bdi>${esc(o.product)}</bdi> · ${esc(o.plan)}</p>\n    <div style=\"display:flex;gap:10px;align-items:center;margin:12px 0\">${pill(o.status)}<span class=\"amt\"><bdi>${usd2(o.price)}</bdi></span><span style=\"color:var(--ink3);font-size:13px\">${fmtDate(o.created)}</span></div>\n    ${o.status === 'delivered' && o.delivery ? `<p style=\"margin-bottom:8px\"><b>بيانات اشتراكك</b></p><div class=\"code\"><pre id=\"code\">${esc(o.delivery)}</pre><button class=\"btn sm\" data-act=\"copy\">نسخ</button></div>`\n      : o.status === 'refunded' ? '<div class=\"note\">تم استرداد المبلغ.</div>'\n      : '<div class=\"warnbox\">طلبك قيد التجهيز. ستظهر بيانات الاشتراك هنا فور تسليمه.</div>'}\n  </div>`;\n}\n\nfunction resultHtml(m) {\n  const good = m.kind === 'ok';\n  const icon = good ? `<div style=\"width:64px;height:64px;border-radius:50%;background:var(--ok-bg);color:var(--ok);display:grid;place-items:center;margin:6px auto 12px\">${ico('check')}</div>` : '';\n  return `<div class=\"modal\" role=\"dialog\" aria-modal=\"true\" style=\"text-align:center\">\n    <button class=\"x\" data-act=\"close\" aria-label=\"إغلاق\">${ico('x')}</button>${icon}\n    <h2 style=\"font-size:22px\">${esc(m.title)}</h2>\n    <p style=\"color:var(--ink2);margin:8px 0 18px\">${esc(m.text)}</p>\n    ${m.kind === 'wait' ? `<button class=\"btn block\" data-act=\"recheck\" data-ref=\"${esc(m.ref)}\">تحقق من الدفع مرة أخرى</button>` : '<a class=\"btn block\" href=\"#/account\" data-act=\"close\">عرض طلباتي</a>'}\n  </div>`;\n}\n\n/* ───────── الإجراءات ───────── */\nfunction addToCart(id, silent) {\n  if (!cart.includes(id)) { cart.push(id); saveCart(); }\n  if (!silent) toast('أُضيف إلى السلة');\n  render();\n}\n\n// يدفع الباقات المحددة: يحوّل لصفحة الدفع، أو يشتري مباشرة إن كان رصيد العميل يكفي\nasync function pay(planIds) {\n  if (S.busy) return;\n  if (S.guest) { closeOverlay(); S.pendingPay = planIds; openAuth({ note: 'أنشئ حسابك أو سجّل الدخول لتكمل الدفع. اختيارك محفوظ.', mode: 'signup', after: 'pay' }); return; }\n  S.busy = true; render();\n  try {\n    const r = await api('/web/checkout', { plan_ids: planIds });\n    if (r.done) {\n      cart = cart.filter((id) => !planIds.includes(id)); saveCart();\n      S.busy = false; await refresh();\n      openModal({ type: 'result', kind: 'ok', title: 'تم استلام طلبك', text: 'تم الخصم من رصيدك. تجد بيانات اشتراكك في «طلباتي».' });\n      return;\n    }\n    location.href = r.url;\n  } catch (e) {\n    S.busy = false; render();\n    if (e.status === 401) { token = ''; store.set('tok', ''); Object.assign(S, GUEST, { guest: true }); render(); }\n    toast(e.message, true);\n  }\n}\n\nasync function handleReturn() {\n  const ref = new URLSearchParams(location.search).get('topup');\n  if (!ref) return;\n  if (S.guest) { openAuth({ note: 'سجّل الدخول لنؤكد دفعتك.', mode: 'login' }); return; }\n  await checkPayment(ref);\n}\nasync function checkPayment(ref) {\n  try {\n    const r = await api('/web/topup/check', { ref });\n    history.replaceState(null, '', location.pathname + '#/account');\n    await refresh();\n    if (r.status === 'paid') {\n      cart = []; saveCart(); render();\n      const res = r.result;\n      if (res && res.missed?.length && !res.bought?.length) openModal({ type: 'result', kind: 'bad', title: 'تم الدفع لكن تعذّر تجهيز الطلب', text: 'نفدت الكمية قبل إتمام طلبك. المبلغ محفوظ كرصيد في حسابك ويُخصم من طلبك القادم، أو تواصل معنا لاسترداده.' });\n      else if (res && res.missed?.length) openModal({ type: 'result', kind: 'ok', title: 'تم الدفع', text: 'جُهّز جزء من طلبك. العناصر التي نفدت قيمتها محفوظة كرصيد في حسابك.' });\n      else openModal({ type: 'result', kind: 'ok', title: 'تم الدفع بنجاح', text: 'تجد بيانات اشتراكك في «طلباتي». الطلبات اليدوية تظهر «قيد التجهيز» حتى نسلّمها.' });\n    } else {\n      openModal({ type: 'result', kind: 'wait', ref, title: 'لم نستلم تأكيد الدفع بعد', text: 'إن أكملت الدفع فقد يستغرق التأكيد دقائق. اضغط للتحقق، ولا تدفع مرة ثانية. وإن لم يكتمل الدفع فلن يُخصم شيء.' });\n    }\n  } catch (e) { toast(e.message, true); }\n}\n\nfunction logout() {\n  api('/web/logout', {}).catch(() => {});\n  token = ''; store.set('tok', ''); Object.assign(S, GUEST, { guest: true });\n  closeOverlay(); location.hash = '#/'; render(); toast('تم تسجيل الخروج');\n}\n\n/* ───────── الأحداث ───────── */\ndocument.addEventListener('click', async (e) => {\n  if (e.target === overlay) { closeOverlay(); return; }\n  const el = e.target.closest('[data-act]');\n  if (!el) return;\n  const d = el.dataset;\n  switch (d.act) {\n    case 'cart': openModal({ type: 'cart' }); break;\n    case 'close': closeOverlay(); break;\n    case 'login': openAuth({ mode: 'login' }); break;\n    case 'authmode': S.authMode = d.m; renderModal(); setTimeout(() => $('#authform input')?.focus(), 30); break;\n    case 'slide': S.slide = Number(d.i); updateSlides(); restartSlides(); break;\n    case 'plan': S.pdpPlan = Number(d.id); render(); break;\n    case 'add': addToCart(Number(d.id)); break;\n    case 'buynow': pay([Number(d.id)]); break;\n    case 'rm': cart = cart.filter((x) => x !== Number(d.id)); saveCart(); render(); break;\n    case 'checkout': pay(cart.slice()); break;\n    case 'order': openModal({ type: 'order', id: Number(d.id) }); break;\n    case 'recheck': closeOverlay(); checkPayment(d.ref); break;\n    case 'logout': logout(); break;\n    case 'clearq': S.q = ''; render(); break;\n    case 'copy': {\n      const text = $('#code')?.textContent || '';\n      (navigator.clipboard?.writeText(text) || Promise.reject()).then(() => toast('تم النسخ')).catch(() => {\n        const r = document.createRange(); r.selectNodeContents($('#code')); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('حدّد النص وانسخه');\n      });\n      break;\n    }\n  }\n});\n\ndocument.addEventListener('submit', async (e) => {\n  if (e.target.dataset.form === 'search') { e.preventDefault(); return; }\n  if (e.target.id !== 'authform') return;\n  e.preventDefault();\n  const f = new FormData(e.target);\n  const btn = e.target.querySelector('button[type=submit]');\n  const err = $('#autherr');\n  btn.disabled = true; err.textContent = '';\n  try {\n    const r = await api(S.authMode === 'signup' ? '/web/signup' : '/web/login', { email: f.get('email'), password: f.get('password'), name: f.get('name') || '' });\n    token = r.token; store.set('tok', token);\n    const after = S.afterAuth; const planIds = S.pendingPay; S.afterAuth = null; S.pendingPay = null; S.authNote = '';\n    closeOverlay(); await refresh();\n    if (after === 'pay' && planIds?.length) { await pay(planIds); return; }\n    toast('أهلًا بك');\n    handleReturn();\n  } catch (e2) { err.textContent = e2.message; btn.disabled = false; }\n});\n\ndocument.addEventListener('input', (e) => {\n  if (e.target.matches('[data-q]')) {\n    S.q = e.target.value;\n    if (parseRoute().name !== 'home') { location.hash = '#/'; return; }\n    render();\n  }\n});\ndocument.addEventListener('change', (e) => { if (e.target.matches('[data-sort]')) { S.sort = e.target.value; render(); } });\ndocument.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) closeOverlay(); });\n\n/* ───────── البانر ───────── */\nfunction updateSlides() {\n  document.querySelectorAll('.bslide').forEach((s, i) => { s.classList.toggle('on', i === S.slide); s.setAttribute('tabindex', i === S.slide ? '0' : '-1'); });\n  document.querySelectorAll('.dots button').forEach((b, i) => (i === S.slide ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')));\n}\nlet slideTimer;\nfunction restartSlides() {\n  clearInterval(slideTimer);\n  slideTimer = setInterval(() => { if (document.hidden || S.banners.length < 2 || !$('.banners')) return; S.slide = (S.slide + 1) % S.banners.length; updateSlides(); }, 5500);\n}\nlet tx = null;\ndocument.addEventListener('touchstart', (e) => { tx = e.target.closest('.banners') ? e.touches[0].clientX : null; }, { passive: true });\ndocument.addEventListener('touchend', (e) => {\n  if (tx === null || S.banners.length < 2) return;\n  const dx = e.changedTouches[0].clientX - tx; tx = null;\n  if (Math.abs(dx) < 40) return;\n  S.slide = (S.slide + (dx < 0 ? 1 : -1) + S.banners.length) % S.banners.length; updateSlides(); restartSlides();\n});\n\n/* ───────── البدء ───────── */\nwindow.addEventListener('pageshow', (ev) => { if (ev.persisted && S.busy) { S.busy = false; render(); } });\nsetInterval(() => {\n  if (document.hidden || !S.loaded || S.guest || S.modal) return;\n  if (S.orders.some((o) => o.status === 'pending' || o.status === 'paid')) refresh().catch(() => {});\n}, 20000);\n\nrestartSlides();\nrefresh().then(handleReturn).catch((e) => {\n  app.innerHTML = `<div class=\"boot\"><div class=\"empty\"><p>${esc(e.message)}</p><button class=\"btn sm\" onclick=\"location.reload()\">حاول مرة أخرى</button></div></div>`;\n});\n"},"/admin.html":{"type":"text/html; charset=utf-8","body":"<!doctype html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n  <meta name=\"robots\" content=\"noindex,nofollow\">\n  <meta name=\"theme-color\" content=\"#141129\">\n  <title>إدارة المتجر</title>\n  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n  <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n  <link href=\"https://fonts.googleapis.com/css2?family=Readex+Pro:wght@300..700&display=swap\" rel=\"stylesheet\">\n  <link rel=\"stylesheet\" href=\"/app.css?v=mv8yx8u1\">\n  <style>\n    body { padding-bottom: 48px; }\n    #adm { max-width: 980px; margin: 0 auto; padding: 18px 16px 0; }\n    .bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }\n    .bar h1 { font-size: 22px; }\n    .tabs { display: flex; gap: 8px; overflow-x: auto; margin: 0 -16px 18px; padding: 0 16px; scrollbar-width: none; }\n    .tabs::-webkit-scrollbar { display: none; }\n    .tabs .cat { position: relative; }\n    .badge { display: inline-block; min-width: 20px; height: 20px; padding: 0 6px; margin-inline-start: 6px; border-radius: 999px; background: var(--star); color: #3a2a00; font-size: 12px; line-height: 20px; text-align: center; font-weight: 600; }\n    .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }\n    @media (min-width: 720px) { .stats { grid-template-columns: repeat(4, 1fr); } }\n    .stat { background: var(--surface); border-radius: 18px; padding: 14px 16px; text-align: start; display: block; width: 100%; }\n    .stat b { display: block; font-size: 24px; font-weight: 600; direction: ltr; text-align: right; font-variant-numeric: tabular-nums; }\n    .stat span { color: var(--muted); font-size: 13px; }\n    button.stat:active { transform: scale(.98); }\n    .alert { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; padding: 12px 14px; border-radius: 16px; background: rgba(255, 197, 61, .13); color: var(--star); }\n    .alert .btn { flex: none; }\n    .alert.ok { background: rgba(95, 240, 207, .1); color: var(--mint); }\n    .alert.bad { background: rgba(255, 138, 152, .12); color: var(--danger); }\n    .card { background: var(--surface); border-radius: 20px; padding: 14px 16px; }\n    .card + .card { margin-top: 10px; }\n    .card .top { display: flex; align-items: center; gap: 12px; }\n    .card .grow { flex: 1; min-width: 0; }\n    .nm { font-weight: 500; line-height: 1.4; }\n    .ltr { direction: ltr; unicode-bidi: plaintext; text-align: right; }\n    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }\n    .inline { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }\n    .inline.end { justify-content: flex-end; }\n    textarea, .in {\n      width: 100%; border: 0; border-radius: 14px; background: var(--surface-2); color: var(--text);\n      padding: 12px 14px; font-size: 15px; outline: 0; min-height: 46px;\n    }\n    textarea { min-height: 84px; resize: vertical; direction: ltr; text-align: left; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 14px; }\n    .in.num { direction: ltr; text-align: left; }\n    textarea:focus, .in:focus { box-shadow: 0 0 0 2px var(--mint); }\n    .in.sm { width: 110px; }\n    .in.md { flex: 1; min-width: 140px; width: auto; }\n    .btn.sm.danger { background: rgba(255, 138, 152, .16); color: var(--danger); }\n    .btn.sm.warn { background: rgba(255, 197, 61, .16); color: var(--star); }\n    .plan-row { padding: 12px 0; border-top: 1px solid var(--line); }\n    .plan-row:first-of-type { border-top: 0; }\n    .plan-row .line { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }\n    .check { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 14px; cursor: pointer; }\n    .check input { width: 18px; height: 18px; accent-color: var(--mint); }\n    .stockline { color: var(--muted); font-size: 13px; }\n    .stockline.low { color: var(--danger); }\n    details.form { margin-bottom: 14px; }\n    details.form > summary { list-style: none; cursor: pointer; }\n    details.form > summary::-webkit-details-marker { display: none; }\n    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }\n    .grid2 .full { grid-column: 1 / -1; }\n    .login { max-width: 420px; margin: 12vh auto 0; }\n    .login h1 { margin-bottom: 6px; }\n    .hint { color: var(--muted); font-size: 13px; margin: 6px 0 0; }\n    .empty-line { color: var(--muted); padding: 24px 0; text-align: center; }\n    .pill.bad { background: rgba(255, 138, 152, .15); color: var(--danger); }\n    .toprow { display: flex; align-items: center; justify-content: space-between; gap: 10px; }\n    .mt { margin-top: 12px; }\n  .tabs .cat{white-space:nowrap}\n</style>\n</head>\n<body>\n  <div id=\"adm\"></div>\n  <div id=\"toast\" role=\"status\"></div>\n<script>\n'use strict';\nconst $ = (s) => document.querySelector(s);\nconst root = $('#adm');\nconst esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' })[c]);\nconst usd = (c) => `$${(c / 100).toFixed(2)}`;\nconst fmtDate = (t) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(t * 1000));\nconst store = {\n  get() { try { return localStorage.getItem('adm') || ''; } catch { return ''; } },\n  set(v) { try { v ? localStorage.setItem('adm', v) : localStorage.removeItem('adm'); } catch {} },\n};\nlet token = store.get();\nconst S = { tab: 'overview', ov: null, orders: [], ostatus: 'pending', cat: null, users: [], q: '', topups: [], armed: null, look: null };\n\nlet tt;\nfunction toast(msg, err) {\n  const el = $('#toast');\n  el.textContent = msg; el.className = 'show' + (err ? ' err' : '');\n  clearTimeout(tt); tt = setTimeout(() => { el.className = ''; }, 3200);\n}\n\nasync function api(path, body) {\n  const h = { 'content-type': 'application/json' };\n  if (token) h.authorization = 'Bearer ' + token;\n  const r = await fetch('/api/admin' + path, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });\n  const j = await r.json().catch(() => ({}));\n  if (!r.ok) {\n    if (r.status === 401 && token) { token = ''; store.set(''); renderLogin('انتهت الجلسة. سجّل الدخول من جديد'); }\n    throw new Error(j.error || 'تعذّر إكمال الطلب');\n  }\n  return j;\n}\n\n/* زر بخطوتين بدل confirm() */\nfunction armed(id) { return S.armed === id; }\nfunction arm(id) { S.armed = id; setTimeout(() => { if (S.armed === id) { S.armed = null; show(); } }, 3500); show(); }\n\n/* ───────── تسجيل الدخول ───────── */\nfunction renderLogin(note) {\n  root.innerHTML = `<div class=\"login\">\n    <h1>إدارة المتجر</h1>\n    <p class=\"muted\">${esc(note || 'اكتب كلمة سر الإدارة.')}</p>\n    <form id=\"lf\" class=\"form\" novalidate>\n      <label class=\"field\"><span>كلمة السر</span><input id=\"pw\" type=\"password\" autocomplete=\"current-password\" dir=\"ltr\" required></label>\n      <div class=\"err\" id=\"le\" role=\"alert\"></div>\n      <button class=\"btn\" type=\"submit\">دخول</button>\n    </form></div>`;\n  $('#lf').addEventListener('submit', async (e) => {\n    e.preventDefault();\n    const b = e.target.querySelector('button'); b.disabled = true; $('#le').textContent = '';\n    try {\n      const r = await api('/login', { password: $('#pw').value });\n      token = r.token; store.set(token); start();\n    } catch (er) { $('#le').textContent = er.message; b.disabled = false; }\n  });\n}\n\n/* ───────── الإطار ───────── */\nconst TABS = [['overview', 'نظرة عامة'], ['orders', 'الطلبات'], ['products', 'المنتجات'], ['users', 'العملاء'], ['topups', 'المدفوعات'], ['look', 'المظهر']];\nfunction shell(inner) {\n  const pend = S.ov?.orders.pending || 0;\n  return `<div class=\"bar\"><h1>إدارة المتجر</h1><button class=\"btn ghost sm\" data-act=\"logout\">خروج</button></div>\n    <div class=\"tabs\" role=\"tablist\">${TABS.map(([k, n]) => `<button class=\"cat\" role=\"tab\" data-act=\"tab\" data-t=\"${k}\" aria-pressed=\"${S.tab === k}\">${n}${k === 'orders' && pend ? `<span class=\"badge\">${pend}</span>` : ''}</button>`).join('')}</div>\n    <div id=\"content\">${inner}</div>`;\n}\n\nfunction show() {\n  const views = { overview: vOverview, orders: vOrders, products: vProducts, users: vUsers, topups: vTopups, look: vLook };\n  const keepScroll = window.scrollY;\n  const focus = document.activeElement?.id;\n  const saved = [...root.querySelectorAll('input[id],textarea[id],select[id]')].map((el) => [el.id, el.type === 'checkbox' ? el.checked : el.value]);\n  const open = [...root.querySelectorAll('details[open]')].map((d) => d.querySelector('[id]')?.id).filter(Boolean);\n  root.innerHTML = shell(views[S.tab]());\n  for (const [id, v] of saved) {\n    const el = document.getElementById(id);\n    if (!el || id === 'uq') continue;\n    if (el.type === 'checkbox') el.checked = v; else if (v !== '' ) el.value = v;\n  }\n  for (const id of open) { const d = document.getElementById(id)?.closest('details'); if (d) d.open = true; }\n  window.scrollTo(0, keepScroll);\n  if (focus) $('#' + focus)?.focus();\n}\n\n/* ───────── نظرة عامة ───────── */\nfunction vOverview() {\n  const o = S.ov;\n  if (!o) return '<div class=\"skeleton\"></div>';\n  const stat = (n, label, act) => `<${act ? 'button' : 'div'} class=\"stat\" ${act ? `data-act=\"${act}\"` : ''}><b>${n}</b><span>${label}</span></${act ? 'button' : 'div'}>`;\n  return `\n    <div class=\"stats\">\n      ${stat(usd(o.salesTodayCents), 'مبيعات آخر 24 ساعة')}\n      ${stat(usd(o.salesCents), 'إجمالي المبيعات')}\n      ${stat(o.orders.pending, 'طلبات تنتظر التسليم', 'go-pending')}\n      ${stat(usd(o.walletsCents), 'أرصدة العملاء')}\n      ${stat(usd(o.topupsCents), 'مدفوعات Sifalo')}\n      ${stat(o.stars, 'نجوم مستلمة')}\n      ${stat(o.users, 'العملاء')}\n      ${stat(o.orders.delivered, 'طلبات مسلّمة')}\n    </div>\n    ${o.orders.pending ? `<div class=\"alert\"><span>${o.orders.pending} طلب بانتظار تسليمك</span><button class=\"btn sm\" data-act=\"go-pending\">افتح الطلبات</button></div>` : ''}\n    ${o.pendingTopups ? `<div class=\"alert\"><span>${o.pendingTopups} شحنة لم يتأكد دفعها بعد</span><button class=\"btn sm\" data-act=\"go-topups\">راجعها</button></div>` : ''}\n    <div class=\"alert ${o.sifalo ? 'ok' : 'bad'}\"><span>${o.sifalo ? `Sifalo Pay مفعّل${o.staging ? ' (وضع التجربة)' : ''}` : 'Sifalo Pay غير مفعّل: أضف SIFALO_API_USER وSIFALO_API_KEY في Cloudflare'}</span></div>\n    ${o.sifalo ? '<div class=\"card\"><button class=\"btn sm\" data-act=\"sifalotest\">فحص اتصال Sifalo</button><pre id=\"stest\" class=\"ltr\" style=\"white-space:pre-wrap;margin:10px 0 0;font-size:12px;direction:ltr;text-align:left\"></pre></div>' : ''}\n    <div class=\"alert ${o.telegram ? 'ok' : ''}\"><span>${o.telegram ? 'بوت تيليجرام مرتبط' : 'بوت تيليجرام غير مضبوط (اختياري)'}</span></div>\n    ${o.lowStock.length ? `<h2>مخزون منخفض</h2>${o.lowStock.map((l) => `<div class=\"card\"><div class=\"toprow\"><span class=\"nm ltr\">${esc(l.name)} — ${esc(l.label)}</span><span class=\"pill ${l.stock ? 'warn' : 'bad'}\">${l.stock ? `متبقي ${l.stock}` : 'نفد'}</span></div></div>`).join('')}` : ''}`;\n}\n\n/* ───────── الطلبات ───────── */\nconst ST = { pending: ['قيد التجهيز', 'warn'], delivered: ['تم التسليم', 'ok'], refunded: ['مسترد', ''] };\nfunction vOrders() {\n  const fl = [['pending', 'قيد التجهيز'], ['delivered', 'تم التسليم'], ['refunded', 'مسترد'], ['', 'الكل']];\n  const list = S.orders.map((o) => {\n    const [t, c] = ST[o.status] || [o.status, ''];\n    return `<div class=\"card\">\n      <div class=\"top\"><div class=\"grow\"><div class=\"nm ltr\">${esc(o.product)}</div><div class=\"muted small\">${esc(o.plan)} — <bdi>${usd(o.price)}</bdi> — طلب <bdi>#${o.id}</bdi></div></div><span class=\"pill ${c}\">${t}</span></div>\n      <div class=\"muted small mt ltr\">${esc(o.who)} · ${fmtDate(o.created)} · ${o.method === 'stars' ? 'نجوم' : o.method === 'card' ? 'بطاقة' : 'رصيد'}</div>\n      ${o.status === 'pending' ? `\n        <label class=\"field mt\"><span>بيانات الاشتراك التي تصل العميل</span><textarea id=\"dl${o.id}\" placeholder=\"email:password أو كود التفعيل\"></textarea></label>\n        <div class=\"inline end\">\n          <button class=\"btn sm danger\" data-act=\"refund\" data-id=\"${o.id}\">${armed('r' + o.id) ? 'اضغط للتأكيد' : 'استرداد'}</button>\n          <button class=\"btn sm\" data-act=\"deliver\" data-id=\"${o.id}\">تسليم</button>\n        </div>` : ''}\n      ${o.status === 'delivered' ? `\n        <div class=\"code mt\"><pre>${esc(o.delivery)}</pre></div>\n        <div class=\"inline end\"><button class=\"btn sm danger\" data-act=\"refund\" data-id=\"${o.id}\">${armed('r' + o.id) ? 'اضغط للتأكيد' : 'استرداد كرصيد للعميل'}</button></div>` : ''}\n    </div>`;\n  }).join('');\n  return `<div class=\"chips\">${fl.map(([k, n]) => `<button class=\"cat\" data-act=\"ofilter\" data-s=\"${k}\" aria-pressed=\"${S.ostatus === k}\">${n}</button>`).join('')}</div>\n    ${list || '<div class=\"empty-line\">لا توجد طلبات هنا</div>'}`;\n}\n\n/* ───────── المنتجات ───────── */\nfunction vProducts() {\n  const c = S.cat;\n  if (!c) return '<div class=\"skeleton\"></div>';\n  const add = `<details class=\"form\"><summary><span class=\"btn ghost sm\" style=\"display:inline-flex\">إضافة منتج جديد</span></summary>\n    <div class=\"card mt\"><div class=\"grid2\">\n      <input class=\"in\" id=\"np-name\" placeholder=\"اسم المنتج (مثل Netflix)\" dir=\"ltr\">\n      <select class=\"in\" id=\"np-cat\">${c.categories.map((k) => `<option value=\"${k.key}\">${esc(k.name)}</option>`).join('')}</select>\n      <input class=\"in\" id=\"np-color\" placeholder=\"اللون #FF5577\" dir=\"ltr\" value=\"#7C6CFF\">\n      <input class=\"in\" id=\"np-glyph\" placeholder=\"رمز: حرف أو حرفان\" maxlength=\"2\" dir=\"ltr\">\n      <input class=\"in full\" id=\"np-desc\" placeholder=\"وصف قصير بالعربي\">\n      <button class=\"btn full\" data-act=\"addproduct\">إضافة المنتج</button>\n    </div></div></details>`;\n  const items = c.products.map((p) => `<div class=\"card\">\n    <div class=\"top\">\n      ${p.img ? `<img src=\"${esc(p.img)}\" alt=\"\" style=\"width:46px;height:46px;border-radius:12px;object-fit:cover;flex:none\">` : `<span class=\"glyph sm\" style=\"--c:${esc(p.color)};--ink:#14112b\">${esc(p.glyph)}</span>`}\n      <div class=\"grow\"><div class=\"nm ltr\">${esc(p.name)}</div><div class=\"muted small\">${esc(p.desc)}</div></div>\n      <button class=\"btn sm ${p.active ? 'ghost' : 'warn'}\" data-act=\"ptoggle\" data-id=\"${p.id}\" data-on=\"${p.active ? 0 : 1}\">${p.active ? 'إخفاء' : 'إظهار'}</button>\n    </div>\n    <div class=\"inline mt\"><label class=\"btn ghost sm\" style=\"cursor:pointer\">${p.img ? 'تغيير الصورة' : 'رفع صورة المنتج'}<input type=\"file\" accept=\"image/*\" hidden data-file=\"pimg\" data-id=\"${p.id}\"></label>${p.img ? `<button class=\"btn sm warn\" data-act=\"pimgdel\" data-id=\"${p.id}\">حذف الصورة</button>` : ''}<span class=\"muted small\">يفضّل صورة مربعة أو 4:3</span></div>\n    <div class=\"mt\">${p.plans.map((x) => `<div class=\"plan-row\">\n      <div class=\"line\">\n        <span class=\"nm\" style=\"min-width:90px\">${esc(x.label)}</span>\n        <input class=\"in sm num\" id=\"pr${x.id}\" type=\"number\" min=\"0.01\" step=\"0.01\" inputmode=\"decimal\" value=\"${(x.price / 100).toFixed(2)}\" aria-label=\"السعر بالدولار\">\n        <label class=\"check\"><input type=\"checkbox\" id=\"mn${x.id}\" ${x.manual ? 'checked' : ''}>تسليم يدوي</label>\n        <button class=\"btn sm\" data-act=\"psave\" data-id=\"${x.id}\">حفظ</button>\n        <button class=\"btn sm ${x.active ? 'ghost' : 'warn'}\" data-act=\"plantoggle\" data-id=\"${x.id}\" data-on=\"${x.active ? 0 : 1}\">${x.active ? 'إخفاء' : 'إظهار'}</button>\n      </div>\n      <div class=\"stockline ${!x.manual && x.stock <= 2 ? 'low' : ''} mt\">المخزون: ${x.stock}${x.manual ? ' (يُباع حتى بدون مخزون)' : ''}</div>\n      <details class=\"mt\"><summary class=\"stockline\" style=\"cursor:pointer\">إضافة مخزون</summary>\n        <textarea id=\"st${x.id}\" placeholder=\"كل سطر = حساب أو كود لعميل واحد\"></textarea>\n        <div class=\"inline end\"><button class=\"btn sm\" data-act=\"addstock\" data-id=\"${x.id}\">إضافة</button></div>\n      </details>\n    </div>`).join('')}</div>\n    <details class=\"mt\"><summary class=\"stockline\" style=\"cursor:pointer\">إضافة باقة</summary>\n      <div class=\"inline\">\n        <input class=\"in md\" id=\"nl${p.id}\" placeholder=\"اسم الباقة (مثل 3 أشهر)\">\n        <input class=\"in sm num\" id=\"np${p.id}\" type=\"number\" min=\"0.01\" step=\"0.01\" inputmode=\"decimal\" placeholder=\"السعر $\">\n        <label class=\"check\"><input type=\"checkbox\" id=\"nm${p.id}\" checked>يدوي</label>\n        <button class=\"btn sm\" data-act=\"addplan\" data-id=\"${p.id}\">إضافة</button>\n      </div>\n    </details>\n  </div>`).join('');\n  return add + items;\n}\n\n/* ───────── العملاء ───────── */\nfunction vUsers() {\n  return `<input class=\"in\" id=\"uq\" type=\"search\" placeholder=\"ابحث بالبريد أو الاسم أو الرقم\" value=\"${esc(S.q)}\" autocomplete=\"off\">\n    <div class=\"mt\">${S.users.map((u) => `<div class=\"card\">\n      <div class=\"top\"><div class=\"grow\"><div class=\"nm ltr\">${esc(u.label)}</div><div class=\"muted small\">${esc(u.name)} · ${u.orders} طلب · ${fmtDate(u.created)}</div></div><b class=\"amt\">${usd(u.balance)}</b></div>\n      <details class=\"mt\"><summary class=\"stockline\" style=\"cursor:pointer\">تعديل الرصيد</summary>\n        <div class=\"inline\">\n          <input class=\"in sm num\" id=\"ca${u.id}\" type=\"number\" step=\"0.01\" inputmode=\"decimal\" placeholder=\"± بالدولار\">\n          <input class=\"in md\" id=\"cn${u.id}\" placeholder=\"ملاحظة (اختياري)\">\n          <button class=\"btn sm\" data-act=\"credit\" data-id=\"${u.id}\">طبّق</button>\n        </div>\n        <p class=\"hint\">اكتب رقمًا موجبًا للإضافة أو سالبًا للخصم.</p>\n      </details></div>`).join('') || '<div class=\"empty-line\">لا يوجد عملاء مطابقون</div>'}</div>`;\n}\n\n/* ───────── المدفوعات ───────── */\nfunction vTopups() {\n  const ST2 = { paid: ['مدفوعة', 'ok'], pending: ['بانتظار التأكيد', 'warn'], failed: ['فشلت', 'bad'] };\n  return S.topups.map((t) => {\n    const [n, c] = ST2[t.status] || [t.status, ''];\n    return `<div class=\"card\">\n      <div class=\"top\"><div class=\"grow\"><div class=\"nm ltr\">${esc(t.who)}</div><div class=\"muted small\">${fmtDate(t.created)}</div></div><b class=\"amt\">${usd(t.cents)}</b><span class=\"pill ${c}\">${n}</span></div>\n      ${t.status !== 'paid' ? `<div class=\"inline end\">\n        ${t.status === 'pending' ? `<button class=\"btn sm\" data-act=\"tverify\" data-ref=\"${t.ref}\">تحقق من الدفع</button>` : ''}\n        <button class=\"btn sm warn\" data-act=\"tcredit\" data-ref=\"${t.ref}\">${armed('c' + t.ref) ? 'أكّد أنك رأيت المبلغ في Sifalo' : 'إضافة يدوية'}</button>\n      </div>` : ''}</div>`;\n  }).join('') || '<div class=\"empty-line\">لا توجد شحنات بعد</div>';\n}\n\n\n/* ───────── المظهر ───────── */\nfunction vLook() {\n  const L = S.look;\n  if (!L) return '<div class=\"skeleton\"></div>';\n  return `<div class=\"card\"><b>شريط الإعلان (اختياري)</b>\n      <div class=\"inline mt\"><input class=\"in md\" id=\"ann\" maxlength=\"160\" placeholder=\"يظهر أعلى الموقع، اتركه فارغًا لإخفائه\" value=\"${esc(L.announce)}\"><button class=\"btn sm\" data-act=\"annsave\">حفظ</button></div></div>\n    <div class=\"card\"><b>إضافة بانر</b>\n      <p class=\"muted small\">المقاس المناسب: <b>1600 × 500</b> بكسل (نسبة 16:5). تُصغَّر الصورة تلقائيًا. الرابط اختياري (مثل #/p/3 لصفحة منتج).</p>\n      <div class=\"inline mt\"><label class=\"btn ghost sm\" style=\"cursor:pointer\">اختر صورة<input type=\"file\" accept=\"image/*\" hidden data-file=\"banner\"></label><span class=\"muted small\" id=\"bnname\">لم تُختر صورة</span></div>\n      <div class=\"inline mt\"><input class=\"in md\" id=\"bnlink\" dir=\"ltr\" placeholder=\"الرابط (اختياري)\"><button class=\"btn sm\" id=\"bnadd\" data-act=\"bnadd\" disabled>إضافة البانر</button></div></div>\n    ${L.banners.length ? L.banners.map((b) => `<div class=\"card\"><img src=\"${esc(b.img)}\" alt=\"\" style=\"width:100%;border-radius:12px;display:block;aspect-ratio:16/5;object-fit:cover\">\n      <div class=\"inline mt\"><input class=\"in md\" id=\"bl${b.id}\" dir=\"ltr\" placeholder=\"الرابط\" value=\"${esc(b.link)}\"><button class=\"btn sm\" data-act=\"bnsave\" data-id=\"${b.id}\">حفظ الرابط</button></div>\n      <div class=\"inline mt\"><button class=\"btn sm ${b.active ? 'ghost' : 'warn'}\" data-act=\"bntoggle\" data-id=\"${b.id}\" data-on=\"${b.active ? 0 : 1}\">${b.active ? 'إخفاء' : 'إظهار'}</button><button class=\"btn sm warn\" data-act=\"bndel\" data-id=\"${b.id}\">${armed('b' + b.id) ? 'أكّد الحذف' : 'حذف'}</button></div></div>`).join('') : '<div class=\"empty-line\">لا توجد بانرات. الصفحة الرئيسية تعرض المنتجات فقط.</div>'}`;\n}\n\n// يصغّر الصورة في المتصفح قبل الرفع (حد أقصى للعرض/الارتفاع) ويرجع data URL بصيغة JPEG\nfunction shrink(file, maxW, maxH) {\n  return new Promise((res, rej) => {\n    const img = new Image();\n    const url = URL.createObjectURL(file);\n    img.onload = () => {\n      const k = Math.min(1, maxW / img.width, maxH / img.height);\n      const c = document.createElement('canvas');\n      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);\n      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);\n      URL.revokeObjectURL(url);\n      let q = 0.88, out = c.toDataURL('image/jpeg', q);\n      while (out.length > 1_200_000 && q > 0.4) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }\n      out.length > 1_300_000 ? rej(new Error('الصورة كبيرة جدًا')) : res(out);\n    };\n    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('تعذّر قراءة الصورة')); };\n    img.src = url;\n  });\n}\nlet bannerData = null;\ndocument.addEventListener('change', async (e) => {\n  const f = e.target.closest?.('[data-file]');\n  if (!f || !f.files[0]) return;\n  const file = f.files[0]; f.value = '';\n  try {\n    if (f.dataset.file === 'banner') {\n      bannerData = await shrink(file, 1600, 700);\n      $('#bnname').textContent = file.name; $('#bnadd').disabled = false;\n    } else if (f.dataset.file === 'pimg') {\n      toast('جارٍ الرفع...');\n      const data = await shrink(file, 900, 900);\n      const m = await api('/media/upload', { data });\n      await act(() => api('/product/image', { id: +f.dataset.id, media_id: m.id }), 'تم رفع صورة المنتج', 'products');\n    }\n  } catch (er) { toast(er.message, true); }\n});\n\n/* ───────── التحميل ───────── */\nasync function load(tab) {\n  try {\n    if (tab === 'overview' || !S.ov) S.ov = await api('/overview');\n    if (tab === 'orders') S.orders = (await api('/orders?status=' + S.ostatus)).orders;\n    if (tab === 'products') S.cat = await api('/catalog');\n    if (tab === 'users') S.users = (await api('/users?q=' + encodeURIComponent(S.q))).users;\n    if (tab === 'topups') S.topups = (await api('/topups')).topups;\n    if (tab === 'look') S.look = await api('/appearance');\n  } catch (e) { if (token) toast(e.message, true); }\n  show();\n}\nasync function go(tab) { S.tab = tab; S.armed = null; show(); await load(tab); window.scrollTo(0, 0); }\n\nasync function act(fn, okMsg, reload) {\n  try { await fn(); if (okMsg) toast(okMsg); S.ov = null; await load(reload || S.tab); }\n  catch (e) { toast(e.message, true); }\n}\n\ndocument.addEventListener('click', (e) => {\n  const el = e.target.closest('[data-act]');\n  if (!el) return;\n  const d = el.dataset;\n  const num = (id) => $('#' + id)?.value;\n  switch (d.act) {\n    case 'tab': go(d.t); break;\n    case 'go-pending': S.ostatus = 'pending'; go('orders'); break;\n    case 'go-topups': go('topups'); break;\n    case 'sifalotest': {\n      const el = $('#stest'); el.textContent = 'جارٍ الفحص...';\n      api('/sifalo/test', {}).then((r) => { el.textContent = (r.ok ? '✅ الاتصال يعمل، Sifalo أعطت رابط دفع' : '❌ فشل الاتصال') + `\\nالبيئة: ${r.env}\\nالخادم: ${r.host}\\nالمستخدم: ${r.user}\\nالحالة: ${r.status}\\nرد Sifalo: ${r.response}`; }).catch((e) => { el.textContent = '❌ ' + e.message; });\n      break;\n    }\n    case 'logout': api('/logout', {}).catch(() => {}); token = ''; store.set(''); renderLogin(); break;\n    case 'ofilter': S.ostatus = d.s; load('orders'); break;\n    case 'deliver': act(() => api('/deliver', { id: +d.id, text: num('dl' + d.id) }), 'تم التسليم', 'orders'); break;\n    case 'refund':\n      if (!armed('r' + d.id)) return arm('r' + d.id);\n      S.armed = null; act(() => api('/refund', { id: +d.id }), 'تم الاسترداد كرصيد للعميل', 'orders'); break;\n    case 'psave': act(() => api('/plan/update', { id: +d.id, price: num('pr' + d.id), manual: $('#mn' + d.id).checked }), 'تم الحفظ', 'products'); break;\n    case 'plantoggle': act(() => api('/plan/update', { id: +d.id, active: +d.on }), 'تم', 'products'); break;\n    case 'ptoggle': act(() => api('/product/update', { id: +d.id, active: +d.on }), 'تم', 'products'); break;\n    case 'addstock': act(() => api('/stock', { plan_id: +d.id, lines: num('st' + d.id) }), 'أُضيف المخزون', 'products'); break;\n    case 'addplan': act(() => api('/plan/add', { product_id: +d.id, label: num('nl' + d.id), price: num('np' + d.id), manual: $('#nm' + d.id).checked }), 'أُضيفت الباقة', 'products'); break;\n    case 'addproduct': act(() => api('/product/add', { name: num('np-name'), cat: num('np-cat'), color: num('np-color'), glyph: num('np-glyph'), desc: num('np-desc') }), 'أُضيف المنتج، أضف له باقة الآن', 'products'); break;\n    case 'credit': act(() => api('/credit', { user_id: +d.id, amount: num('ca' + d.id), note: num('cn' + d.id) }), 'تم تعديل الرصيد', 'users'); break;\n    case 'pimgdel': act(() => api('/product/image', { id: +d.id, media_id: null }), 'حُذفت الصورة', 'products'); break;\n    case 'annsave': act(() => api('/settings', { announce: num('ann') }), 'تم الحفظ', 'look'); break;\n    case 'bnadd': act(async () => { if (!bannerData) throw new Error('اختر صورة أولًا'); const m = await api('/media/upload', { data: bannerData }); await api('/banner/add', { media_id: m.id, link: num('bnlink') }); bannerData = null; }, 'أُضيف البانر', 'look'); break;\n    case 'bnsave': act(() => api('/banner/update', { id: +d.id, link: num('bl' + d.id) }), 'تم الحفظ', 'look'); break;\n    case 'bntoggle': act(() => api('/banner/update', { id: +d.id, active: +d.on }), 'تم', 'look'); break;\n    case 'bndel':\n      if (!armed('b' + d.id)) return arm('b' + d.id);\n      S.armed = null; act(() => api('/banner/delete', { id: +d.id }), 'حُذف البانر', 'look'); break;\n    case 'tverify': act(async () => { const r = await api('/topup/verify', { ref: d.ref }); toast(r.status === 'paid' ? 'تأكد الدفع وأُضيف الرصيد' : 'لم يتأكد الدفع بعد في Sifalo'); }, '', 'topups'); break;\n    case 'tcredit':\n      if (!armed('c' + d.ref)) return arm('c' + d.ref);\n      S.armed = null; act(() => api('/topup/credit', { ref: d.ref }), 'أُضيف الرصيد يدويًا', 'topups'); break;\n  }\n});\n\nlet qt;\ndocument.addEventListener('input', (e) => {\n  if (e.target.id === 'uq') { S.q = e.target.value; clearTimeout(qt); qt = setTimeout(() => load('users'), 300); }\n});\n\nasync function start() {\n  if (!token) return renderLogin();\n  S.tab = 'overview'; S.ov = null; show(); await load('overview');\n}\nstart();\n</script>\n</body>\n</html>\n"},"/logo.webp":{"type":"image/webp","b64":"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"}};

/* ───────── نقطة الدخول ───────── */
export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/') || pathname.startsWith('/setup/') || pathname.startsWith('/media/') || pathname === '/tg') {
      return env.STORE.get(env.STORE.idFromName('main')).fetch(request);
    }
    const isAdmin = pathname === '/admin' || pathname === '/admin/' || pathname === '/admin.html';
    const a = ASSETS[isAdmin ? '/admin.html' : pathname === '/' ? '/index.html' : pathname];
    if (!a || (request.method !== 'GET' && request.method !== 'HEAD')) return new Response('Not found', { status: 404 });
    const headers = { 'content-type': a.type, 'cache-control': a.b64 ? 'public, max-age=86400' : 'no-cache', 'x-content-type-options': 'nosniff' };
    if (isAdmin) Object.assign(headers, { 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' });
    return new Response(a.b64 ? Uint8Array.from(atob(a.b64), (c) => c.charCodeAt(0)) : a.body, { headers });
  },
};
