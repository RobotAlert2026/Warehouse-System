// ===== DATA =====
const STORAGE_KEY = 'sparepart_v1';
const CART_KEY = 'sparepart_cart_v1';
const DATA_DOCUMENT = 'warehouse/data';
const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();

const DEFAULT_PARTS = [];
const DEFAULT_HISTORY = [];

let parts = [];
let history = [];
let receipts = [];
let cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); // [{partId, qty}]
let modalPartId = null;
let editingPartId = null;
let approvers = [];
let approverLoadError = '';
let registrationNotice = '';
let currentUser = JSON.parse(localStorage.getItem('sparepart_user') || 'null');
let pendingProtectedPage = null;
let needsCloudMigration = false;

function setLoading(isLoading, message = 'กำลังโหลด...') {
  const overlay = document.getElementById('loading-overlay');
  const messageElement = document.getElementById('loading-message');
  if (!overlay) return;
  if (messageElement) messageElement.textContent = message;
  overlay.classList.toggle('hidden', !isLoading);
}

async function loadData() {
  const stored = localStorage.getItem(STORAGE_KEY);
  let fallback = { parts: [...DEFAULT_PARTS], history: [...DEFAULT_HISTORY], receipts: [] };
  if (stored) {
    try {
      fallback = { ...fallback, ...JSON.parse(stored) };
    } catch (error) {
      console.warn('ข้อมูลสำรองในเครื่องไม่ใช่ JSON ที่ถูกต้อง:', error);
    }
  }

  if (db) {
    let snapshot = null;
    try {
      snapshot = await db.doc(DATA_DOCUMENT).get();
    } catch (error) {
      // Public browsing should still work while Firestore Rules are being deployed.
      if (error.code !== 'permission-denied') throw error;
      console.warn('ยังอ่าน Firestore ไม่ได้ ใช้ข้อมูลสำรองในเครื่องแทน:', error.code);
    }
    if (snapshot?.exists) {
      const remote = snapshot.data();
      // Keep previously saved browser data visible when Firestore has an empty document.
      // This also supports the first migration from the old localStorage-based version.
      const remoteParts = Array.isArray(remote.parts) ? remote.parts : [];
      const remoteHistory = Array.isArray(remote.history) ? remote.history : [];
      const remoteReceipts = Array.isArray(remote.receipts) ? remote.receipts : [];
      const localParts = Array.isArray(fallback.parts) ? fallback.parts : [];
      const localHistory = Array.isArray(fallback.history) ? fallback.history : [];
      const localReceipts = Array.isArray(fallback.receipts) ? fallback.receipts : [];
      const usingLocalParts = remoteParts.length === 0 && localParts.length > 0;
      const usingLocalHistory = remoteHistory.length === 0 && localHistory.length > 0;
      const usingLocalReceipts = remoteReceipts.length === 0 && localReceipts.length > 0;
      needsCloudMigration = usingLocalParts || usingLocalHistory || usingLocalReceipts;
      parts = (usingLocalParts ? localParts : remoteParts).map(p => ({ ...p, image: sanitizeStoredImage(p.image) }));
      history = usingLocalHistory ? localHistory : remoteHistory;
      receipts = usingLocalReceipts ? localReceipts : remoteReceipts;
      return { parts, history };
    }
  }

  parts = (fallback.parts || [...DEFAULT_PARTS]).map(p => ({ ...p, image: sanitizeStoredImage(p.image) }));
  history = fallback.history || [...DEFAULT_HISTORY];
  receipts = fallback.receipts || [];
  needsCloudMigration = parts.length > 0 || history.length > 0 || receipts.length > 0;
  return { parts, history };
}

async function saveData(partsToSave, historyToSave) {
  if (db) {
    try {
      await db.doc(DATA_DOCUMENT).set({ parts: partsToSave, history: historyToSave, receipts });
    } catch (error) {
      console.error('บันทึก Firestore ไม่สำเร็จ:', error.code, error.message);
      throw new Error(`บันทึก Firestore ไม่สำเร็จ (${error.code || 'unknown-error'})`);
    }
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ parts: partsToSave, history: historyToSave, receipts }));
}

function saveCart() {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
}

async function initializeData() {
  await loadData();
  if (needsCloudMigration && currentUser && currentUser.role !== 'Guest') {
    await saveData(parts, history);
    needsCloudMigration = false;
    console.info('ย้ายข้อมูลเดิมจากเครื่องขึ้น Firestore สำเร็จ');
  }
}

async function refreshApprovalData(showMessage = true) {
  if (!currentUser) return;
  try {
    await loadData();
    renderApprovalRequests();
    renderHistory();
    if (showMessage) toast('อัปเดตคำขอเบิกล่าสุดแล้ว', 'success');
  } catch (error) {
    toast(`โหลดคำขอเบิกไม่สำเร็จ (${error.code || 'unknown-error'})`, 'error');
  }
}

async function loadUserProfile(uid) {
  try {
    for (const collectionName of ['user', 'users', 'admin']) {
      const snapshot = await db.collection(collectionName).doc(uid).get();
      if (snapshot.exists) {
        return { ...snapshot.data(), profileCollection: collectionName };
      }
    }
  } catch (error) {
    if (error.code !== 'permission-denied') throw error;
    console.warn('อ่าน Profile ไม่ได้ ใช้ข้อมูลจาก Firebase Authentication แทน:', error.code);
  }
  return {};
}

function normalizeRole(role) {
  return String(role || '').trim().toLowerCase() === 'admin' ? 'Admin' : 'User';
}

async function loadApprovers() {
  const approverSelect = document.getElementById('cart-approver');
  if (!approverSelect || !currentUser || currentUser.role === 'Guest') return;
  approverLoadError = '';
  try {
    const snapshot = await db.collection('user').get();
    approvers = snapshot.docs
      .map(item => ({ uid: item.id, ...item.data() }))
      .filter(item => normalizeRole(item.role) === 'Admin');
  } catch (error) {
    console.warn('โหลดรายชื่อ Admin ไม่สำเร็จ:', error.code);
    approverLoadError = error.code || 'unknown-error';
    approvers = [];
  }
  if (currentUser?.role === 'Admin' && !approvers.some(item => item.uid === currentUser.uid)) {
    approvers.unshift({ uid: currentUser.uid, name: currentUser.name, role: 'Admin' });
  }
  approverSelect.innerHTML = approvers.length
    ? approvers.map(item => `<option value="${item.uid}">${item.name || item.email || item.uid}</option>`).join('')
    : `<option value="">${approverLoadError === 'permission-denied' ? 'ไม่มีสิทธิ์โหลดรายชื่อ Admin' : 'ไม่พบผู้อนุมัติ Admin'}</option>`;
}

async function loadPendingUsers() {
  const card = document.getElementById('pending-users-card');
  const list = document.getElementById('pending-users-list');
  const count = document.getElementById('pending-users-count');
  if (!card || !list || !count || currentUser?.role !== 'Admin') return;
  try {
    const snapshot = await db.collection('user').get();
    const pending = snapshot.docs
      .map(item => ({ uid: item.id, ...item.data() }))
      .filter(item => item.status === 'pending');
    count.textContent = `${pending.length} คน`;
    card.classList.toggle('hidden', pending.length === 0);
    list.innerHTML = pending.map(item => `<div class="rec-item">
      <div class="rec-icon" style="background:var(--accent-soft);color:var(--accent)">👤</div>
      <div class="rec-body"><div class="rec-title">${item.name || 'ไม่ระบุชื่อ'}</div><div class="rec-desc">${item.email || '-'} · สมัครเมื่อ ${formatDisplayDateTime(item.createdAt)}</div></div>
      <div class="btn-row"><button class="btn btn-success btn-sm" onclick="approveUser('${item.uid}')">อนุมัติ</button><button class="btn btn-danger btn-sm" onclick="rejectUser('${item.uid}')">ปฏิเสธ</button></div>
    </div>`).join('');
  } catch (error) {
    card.classList.remove('hidden');
    count.textContent = '-';
    list.innerHTML = `<div class="access-block">โหลดผู้สมัครไม่สำเร็จ (${error.code || 'unknown-error'})</div>`;
  }
}

async function updateUserStatus(uid, status) {
  if (currentUser?.role !== 'Admin') {
    toast('เฉพาะ Admin เท่านั้นที่จัดการผู้สมัครได้', 'error');
    return;
  }
  try {
    await db.collection('user').doc(uid).update({ status, reviewedBy: currentUser.uid, reviewedAt: new Date().toISOString() });
    await loadPendingUsers();
    toast(status === 'approved' ? 'อนุมัติผู้ใช้สำเร็จ' : 'ปฏิเสธผู้ใช้สำเร็จ', 'success');
  } catch (error) {
    toast(`อัปเดตผู้ใช้ไม่สำเร็จ (${error.code || 'unknown-error'})`, 'error');
  }
}

function approveUser(uid) { return updateUserStatus(uid, 'approved'); }
function rejectUser(uid) { return updateUserStatus(uid, 'rejected'); }

function makePlaceholderImage(text) {
  const safeText = String(text || 'Spare Part').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="100%" height="100%" rx="16" fill="#dbeafe"/><rect x="12" y="12" width="96" height="96" rx="12" fill="#eff6ff"/><text x="60" y="70" text-anchor="middle" font-size="14" fill="#2563eb">${safeText}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function isGeneratedPlaceholderImage(value) {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.startsWith('data:image/svg+xml;utf8,<svg') && trimmed.includes('<text');
}

function sanitizeStoredImage(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (isGeneratedPlaceholderImage(trimmed)) return '';
  return trimmed;
}

function looksLikeImageReference(value) {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('data:image/')) return true;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^[^\s]+\.[a-zA-Z0-9]{2,6}$/.test(trimmed)) return true;
  if (/^[^\s]+\/[^^\s]+\.[a-zA-Z0-9]{2,6}$/.test(trimmed)) return true;
  return false;
}

function normalizeImageUrl(value, fallbackText) {
  if (!value || typeof value !== 'string') return makePlaceholderImage(fallbackText || 'Spare Part');
  const trimmed = value.trim();
  if (!trimmed) return makePlaceholderImage(fallbackText || 'Spare Part');
  if (trimmed.startsWith('data:image/') || trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return encodeURI(trimmed);
  }
  if (trimmed.startsWith('/')) {
    return encodeURI(`${window.location.origin}${trimmed}`);
  }
  return makePlaceholderImage(fallbackText || 'Spare Part');
}

function getPartImage(p) {
  return normalizeImageUrl(p.image, p.name || p.code || 'Spare Part');
}

function formatDisplayDate(value) {
  if (!value) return '-';
  const text = String(value).trim();
  if (!text) return '-';
  const normalized = text.includes('T') ? text.split('T')[0] : text;
  const datePart = normalized.split(' ')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return text;
  const [year, month, day] = datePart.split('-');
  return `${day}/${month}/${year}`;
}

function formatDisplayDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return formatDisplayDate(value);
  return date.toLocaleString('th-TH', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function openImagePreview(src, event) {
  if (event) event.stopPropagation();
  const modal = document.getElementById('image-preview-modal');
  const img = document.getElementById('image-preview-img');
  if (!modal || !img) return;
  img.src = src;
  modal.classList.add('open');
}

function closeImagePreview(event) {
  if (event) event.stopPropagation();
  const modal = document.getElementById('image-preview-modal');
  if (modal) modal.classList.remove('open');
}

function readImageFile(file, callback) {
  if (!file) return callback('');
  const reader = new FileReader();
  reader.onload = () => callback(reader.result || '');
  reader.readAsDataURL(file);
}

async function uploadImageToFirebaseStorage(file) {
  if (!file) return '';
  if (!file.type.startsWith('image/')) throw new Error('ไฟล์ต้องเป็นรูปภาพเท่านั้น');
  if (file.size > 5 * 1024 * 1024) throw new Error('รูปภาพต้องมีขนาดไม่เกิน 5 MB');

  const extension = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const uniqueId = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  const storageRef = storage.ref(`warehouse/parts/${Date.now()}-${uniqueId}.${extension}`);
  const snapshot = await storageRef.put(file, {
    contentType: file.type,
    customMetadata: { uploadedAt: new Date().toISOString() }
  });
  return await snapshot.ref.getDownloadURL();
}

function toggleTheme() {
  const body = document.body;
  const isDark = body.classList.toggle('dark-mode');
  const button = document.getElementById('theme-toggle');
  if (button) {
    button.textContent = isDark ? '☀︎' : '☾';
    button.title = isDark ? 'สลับเป็นโหมดสว่าง' : 'สลับเป็นโหมดมืด';
  }
  localStorage.setItem('sparepart_theme', isDark ? 'dark' : 'light');
}

function applySavedTheme() {
  const saved = localStorage.getItem('sparepart_theme');
  const body = document.body;
  const button = document.getElementById('theme-toggle');
  if (saved === 'dark') {
    body.classList.add('dark-mode');
    if (button) { button.textContent = '☀︎'; button.title = 'สลับเป็นโหมดสว่าง'; }
  } else {
    body.classList.remove('dark-mode');
    if (button) { button.textContent = '☾'; button.title = 'สลับเป็นโหมดมืด'; }
  }
}

function showApp() {
  currentUser = currentUser || { name: 'Guest', role: 'Guest' };
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  document.getElementById('login-btn').style.display = currentUser.role === 'Guest' ? 'inline-flex' : 'none';
  document.getElementById('user-chip').style.display = currentUser.role === 'Guest' ? 'none' : 'inline-flex';
  document.getElementById('logout-btn').style.display = currentUser.role === 'Guest' ? 'none' : 'inline-flex';
  document.getElementById('user-chip').innerHTML = `👤 ${currentUser.name} <span style="opacity:.7">(${currentUser.role})</span>`;
  document.getElementById('cart-withdrawer').value = currentUser.role === 'Guest' ? '' : currentUser.name;
  applyAccessState();
  updateAlerts();
  updateCartBadge();
  renderDashboard();
  renderInventory();
  renderShop();
  renderCart();
  renderHistory();
  renderLowStock();
  renderRecommendations();
  loadPendingUsers();
  if (currentUser.role === 'Guest') return;
  if (pendingProtectedPage) {
    const nextPage = pendingProtectedPage;
    pendingProtectedPage = null;
    navigate(nextPage);
  }
  toast(`เข้าสู่ระบบสำเร็จ ยินดีต้อนรับ ${currentUser.name}`, 'success');
}

function showLogin() {
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('user-chip').style.display = 'none';
  document.getElementById('logout-btn').style.display = 'none';
  document.getElementById('login-btn').style.display = 'none';
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
  const message = document.getElementById('login-message');
  message.className = registrationNotice ? 'login-message success' : 'login-message';
  message.textContent = registrationNotice;
  registrationNotice = '';
}

function showLoginPrompt() {
  document.getElementById('app-shell').classList.remove('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('login-email').focus();
}

function closeLoginPrompt() {
  if (currentUser && currentUser.role !== 'Guest') return;
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
}

function toggleRegistration(show = true) {
  const form = document.getElementById('registration-form');
  if (!form) return;
  form.classList.toggle('hidden', !show);
  if (!show) {
    ['register-name', 'register-email', 'register-password'].forEach(id => {
      document.getElementById(id).value = '';
    });
  }
}

async function handleRegistration() {
  const name = document.getElementById('register-name').value.trim();
  const email = document.getElementById('register-email').value.trim();
  const password = document.getElementById('register-password').value;
  const message = document.getElementById('login-message');
  if (!name || !email || password.length < 6) {
    message.textContent = 'กรุณากรอกชื่อ อีเมล และรหัสผ่านอย่างน้อย 6 ตัวอักษร';
    return;
  }
  setLoading(true, 'กำลังสร้างบัญชี...');
  try {
    const credential = await auth.createUserWithEmailAndPassword(email, password);
    await db.collection('user').doc(credential.user.uid).set({
      name,
      email,
      role: 'User',
      status: 'pending',
      createdAt: new Date().toISOString()
    });
    await auth.signOut();
    toggleRegistration(false);
    registrationNotice = 'สมัครสมาชิกสำเร็จ บัญชีอยู่ระหว่างรอ Admin อนุมัติ';
    setLoading(false);
    showLogin();
  } catch (error) {
    const messages = {
      'auth/email-already-in-use': 'อีเมลนี้ถูกใช้งานแล้ว',
      'auth/invalid-email': 'รูปแบบอีเมลไม่ถูกต้อง',
      'auth/operation-not-allowed': 'ยังไม่ได้เปิด Email/Password ใน Firebase Authentication',
      'auth/weak-password': 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร'
    };
    message.className = 'login-message';
    message.textContent = messages[error.code] || `สมัครสมาชิกไม่สำเร็จ (${error.code || 'unknown-error'})`;
    setLoading(false);
  }
}

async function handleLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const message = document.getElementById('login-message');
  message.textContent = '';
  if (!email || !password) {
    message.textContent = 'กรุณากรอกอีเมลและรหัสผ่าน';
    return;
  }
  setLoading(true, 'กำลังตรวจสอบบัญชี...');
  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (error) {
    const messages = {
      'auth/invalid-credential': 'อีเมลหรือรหัสผ่านไม่ถูกต้อง หรือยังไม่มีบัญชีนี้ใน Firebase',
      'auth/user-not-found': 'ยังไม่มีบัญชีนี้ กรุณาสร้างผู้ใช้ใน Firebase Authentication',
      'auth/wrong-password': 'รหัสผ่านไม่ถูกต้อง',
      'auth/operation-not-allowed': 'ยังไม่ได้เปิด Email/Password ใน Firebase Authentication',
      'auth/invalid-email': 'รูปแบบอีเมลไม่ถูกต้อง',
      'auth/too-many-requests': 'ลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่'
    };
    message.textContent = messages[error.code] || `เข้าสู่ระบบไม่สำเร็จ (${error.code || 'unknown-error'})`;
    setLoading(false);
  }
}

async function logout() {
  const confirmed = window.confirm('ต้องการออกจากระบบใช่หรือไม่?');
  if (!confirmed) return;
  await auth.signOut();
  currentUser = null;
  localStorage.removeItem('sparepart_user');
  showApp();
}

function getEffectivePermissions() {
  if (!currentUser || currentUser.role === 'Guest') return { receive: false, withdraw: true, adminOnly: false };
  if (currentUser.role === 'Admin') return { receive: true, withdraw: true, adminOnly: true };
  return { receive: false, withdraw: true, adminOnly: false };
}

function canAccessAction(action) {
  return getEffectivePermissions()[action] === true;
}

function applyAccessState() {
  const receiveAllowed = canAccessAction('receive');
  const withdrawAllowed = canAccessAction('withdraw');
  const adminOnly = canAccessAction('adminOnly');
  const receiveNav = document.getElementById('nav-receive');
  const shopNav = document.getElementById('nav-shop');
  const cartNav = document.getElementById('nav-cart');
  const lowstockNav = document.getElementById('nav-lowstock');
  const recommendNav = document.getElementById('nav-recommend');
  const receiveBlock = document.getElementById('receive-access-block');
  const receiveWrapper = document.getElementById('receive-form-wrapper');
  const shopBlock = document.getElementById('shop-access-block');
  const shopWrapper = document.getElementById('shop-wrapper');
  const cartBlock = document.getElementById('cart-access-block');
  const cartWrapper = document.getElementById('cart-wrapper');

  if (receiveNav) receiveNav.classList.toggle('disabled', !receiveAllowed);
  if (shopNav) shopNav.classList.toggle('disabled', !withdrawAllowed);
  if (cartNav) cartNav.classList.toggle('disabled', !withdrawAllowed);
  if (lowstockNav) {
    lowstockNav.style.display = '';
    lowstockNav.classList.toggle('disabled', !adminOnly);
  }
  if (recommendNav) {
    recommendNav.style.display = '';
    recommendNav.classList.toggle('disabled', !adminOnly);
  }
  if (receiveBlock) receiveBlock.classList.toggle('hidden', receiveAllowed);
  if (receiveWrapper) receiveWrapper.classList.toggle('hidden', !receiveAllowed);
  if (shopBlock) shopBlock.classList.toggle('hidden', withdrawAllowed);
  if (shopWrapper) shopWrapper.classList.toggle('hidden', !withdrawAllowed);
  if (cartBlock) cartBlock.classList.toggle('hidden', withdrawAllowed);
  if (cartWrapper) cartWrapper.classList.toggle('hidden', !withdrawAllowed);
}

// ===== NAVIGATION =====
const PAGES = ['dashboard','shop','cart','inventory','receive','history','lowstock','recommend'];
const TITLES = {
  dashboard: 'Dashboard', shop: 'เลือกอะไหล่', cart: 'ตะกร้าเบิกของฉัน',
  inventory: 'คลังอะไหล่ทั้งหมด', receive: 'รับอะไหล่เข้าคลัง',
  history: 'ประวัติการเบิก', lowstock: 'แจ้งเตือนสต็อกต่ำ', recommend: 'ข้อแนะนำจากระบบ'
};

function navigate(page) {
  if ((page === 'shop' || page === 'cart') && (!currentUser || currentUser.role === 'Guest')) {
    pendingProtectedPage = page;
    showLoginPrompt();
    return;
  }
  if ((page === 'receive' && !canAccessAction('receive')) || ((page === 'shop' || page === 'cart') && !canAccessAction('withdraw'))) {
    toast('คุณไม่มีสิทธิ์ใช้งานหน้านี้ โปรดติดต่อ Admin', 'error');
    return;
  }
  if ((page === 'lowstock' || page === 'recommend') && !canAccessAction('adminOnly')) {
    toast('เฉพาะ Admin เท่านั้นที่เข้าถึงหน้านี้ได้', 'error');
    return;
  }

  PAGES.forEach(p => {
    document.getElementById('page-' + p).classList.toggle('active', p === page);
    document.querySelectorAll('.nav-item').forEach(el => {
      if (el.getAttribute('onclick') === `navigate('${p}')`) el.classList.toggle('active', p === page);
    });
  });
  document.getElementById('page-title').textContent = TITLES[page] || page;
  if (page === 'dashboard') renderDashboard();
  if (page === 'shop') renderShop();
  if (page === 'cart') {
    renderCart();
    loadApprovers();
  }
  if (page === 'inventory') renderInventory();
  if (page === 'history') {
    renderHistory();
    refreshApprovalData(false);
  }
  if (page === 'lowstock') renderLowStock();
  if (page === 'recommend') renderRecommendations();
}

// ===== UTILS =====
function getLowStockParts() { return parts.filter(p => p.qty <= p.minQty); }
function getStockStatus(p) {
  if (p.qty === 0) return { label:'หมดสต็อก', cls:'badge-red' };
  if (p.qty <= p.minQty) return { label:'ใกล้หมด', cls:'badge-amber' };
  return { label:'ปกติ', cls:'badge-green' };
}
function cartQtyFor(partId) {
  const c = cart.find(x => x.partId === partId);
  return c ? c.qty : 0;
}
function cartTotalItems() { return cart.reduce((s, c) => s + c.qty, 0); }

function toast(msg, type = 'success') {
  const w = document.getElementById('toast-wrap');
  const el = document.createElement('div');
  const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
  el.className = `toast ${type}`;
  el.innerHTML = `${icon} ${msg}`;
  w.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function updateAlerts() {
  const low = getLowStockParts();
  const n = low.length;
  const isAdmin = currentUser?.role === 'Admin';
  document.getElementById('low-badge').textContent = n;
  document.getElementById('alert-count').textContent = n;
  document.getElementById('alert-btn').style.display = (n > 0 && isAdmin) ? 'flex' : 'none';
  document.getElementById('stat-lowstock').textContent = n;
  document.getElementById('stat-total').textContent = parts.length;
  const pendingCount = history.filter(entry => entry.status === 'pending').length;
  const approvalAlert = document.getElementById('approval-alert');
  const approvalAlertCount = document.getElementById('approval-alert-count');
  if (approvalAlert && approvalAlertCount) {
    approvalAlertCount.textContent = pendingCount;
    approvalAlert.style.display = currentUser?.role === 'Admin' && pendingCount > 0 ? 'flex' : 'none';
  }
}

function updateCartBadge() {
  const n = cartTotalItems();
  const navBadge = document.getElementById('cart-nav-badge');
  const fabBadge = document.getElementById('cart-fab-badge');
  if (navBadge) { navBadge.textContent = n; navBadge.style.display = n > 0 ? 'inline-flex' : 'none'; }
  if (fabBadge) { fabBadge.textContent = n; fabBadge.style.display = n > 0 ? 'flex' : 'none'; }
}

// ===== DASHBOARD =====
let chartMonthly, chartCategory;

function renderDashboard() {
  updateAlerts();

  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const monthlyReceipts = receipts.filter(item => item.date.startsWith(thisMonth));
  document.getElementById('stat-received').textContent = monthlyReceipts.length;
  const monthlyReceivedValue = monthlyReceipts.reduce((total, item) => total + Number(item.total || 0), 0);
  document.getElementById('stat-received-value').textContent = `฿${monthlyReceivedValue.toLocaleString('th-TH', { maximumFractionDigits: 2 })}`;
  document.getElementById('stat-withdrawn').textContent = history.filter(h => h.date.startsWith(thisMonth) && h.status === 'approved').length;
  const stockValue = parts.reduce((total, part) => total + (Number(part.qty) * Number(part.unitPrice || 0)), 0);
  document.getElementById('stat-stock-value').textContent = `฿${stockValue.toLocaleString('th-TH', { maximumFractionDigits: 2 })}`;

  const low = getLowStockParts();
  document.getElementById('dash-low-count').textContent = `${low.length} รายการ`;
  const lsList = document.getElementById('dash-lowstock-list');
  lsList.innerHTML = low.length === 0
    ? '<div class="empty"><div class="empty-icon">✅</div>ไม่มีอะไหล่ใกล้หมด</div>'
    : low.map(p => {
        const pct = Math.min(100, Math.round((p.qty / p.minQty) * 100));
        const color = p.qty === 0 ? 'var(--red)' : 'var(--amber)';
        return `<div class="low-stock-item">
          <div><div class="ls-name">${p.name}</div><div class="ls-code">${p.code}</div></div>
          <div class="ls-bar-wrap">
            <div class="ls-bar"><div class="ls-bar-fill" style="width:${pct}%;background:${color}"></div></div>
          </div>
          <span style="font-family:var(--mono);font-size:13px;color:${color};min-width:32px;text-align:right">${p.qty}</span>
        </div>`;
      }).join('');

  const rec = [...history].sort((a,b) => b.date.localeCompare(a.date)).slice(0,5);
  const rList = document.getElementById('dash-recent-withdrawals');
  rList.innerHTML = rec.length === 0
    ? '<div class="empty"><div class="empty-icon">📋</div>ยังไม่มีประวัติการเบิก</div>'
    : `<div class="table-wrap"><table>
        <thead><tr><th>วันที่</th><th>อะไหล่</th><th>จำนวน</th><th>เครื่องจักร</th></tr></thead>
        <tbody>${rec.map(h => `<tr>
          <td style="color:var(--muted)">${h.date}</td>
          <td>${h.partName}</td>
          <td><span class="badge badge-amber">${h.qty}</span></td>
          <td style="font-family:var(--mono);font-size:12px">${h.machine}</td>
        </tr>`).join('')}</tbody>
      </table></div>`;

  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    months.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
  }
  const monthlyData = months.map(m => history.filter(h => h.date.startsWith(m)).reduce((s,h) => s + h.qty, 0));
  const monthLabels = months.map(m => { const d = new Date(m+'-01'); return d.toLocaleDateString('th-TH', {month:'short'}); });

  const gridColor = getComputedStyle(document.body).getPropertyValue('--divider') || 'rgba(37,99,235,0.1)';
  const tickColor = getComputedStyle(document.body).getPropertyValue('--muted') || '#6b7fa3';

  if (chartMonthly) chartMonthly.destroy();
  chartMonthly = new Chart(document.getElementById('chart-monthly'), {
    type: 'bar',
    data: {
      labels: monthLabels,
      datasets: [{ label: 'จำนวนเบิก', data: monthlyData, backgroundColor: 'rgba(37,99,235,0.75)', borderRadius: 6 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: tickColor }, grid: { display: false } }, y: { ticks: { color: tickColor }, grid: { color: gridColor } } } }
  });

  const cats = {};
  parts.forEach(p => { cats[p.category] = (cats[p.category] || 0) + p.qty; });
  const COLORS = ['#2563eb','#3b82f6','#60a5fa','#0ea5e9','#38bdf8','#93c5fd','#1d4ed8','#0284c7'];
  if (chartCategory) chartCategory.destroy();
  chartCategory = new Chart(document.getElementById('chart-category'), {
    type: 'doughnut',
    data: {
      labels: Object.keys(cats),
      datasets: [{ data: Object.values(cats), backgroundColor: COLORS.slice(0, Object.keys(cats).length), borderWidth: 0 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: tickColor, boxWidth: 12, padding: 8, font: { size: 11 } } } } }
  });
}

// ===== SHOP (Shopee/Lazada-style catalog with add-to-cart) =====
function renderShop() {
  const q = (document.getElementById('shop-search')?.value || '').toLowerCase();
  const cat = document.getElementById('shop-cat')?.value || '';

  const cats = [...new Set(parts.map(p => p.category))].sort();
  const catSel = document.getElementById('shop-cat');
  if (catSel) {
    const curCat = catSel.value;
    catSel.innerHTML = '<option value="">ทุกประเภท</option>' + cats.map(c => `<option value="${c}" ${c===curCat?'selected':''}>${c}</option>`).join('');
  }

  const filtered = parts.filter(p =>
    (!q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q)) &&
    (!cat || p.category === cat)
  );

  const grid = document.getElementById('shop-grid');
  if (!grid) return;
  grid.innerHTML = filtered.length === 0
    ? `<div class="empty" style="grid-column:1/-1"><div class="empty-icon">🛒</div>ไม่พบอะไหล่ที่ค้นหา</div>`
    : filtered.map(p => {
        const st = getStockStatus(p);
        const inCart = cartQtyFor(p.id);
        const outOfStock = p.qty === 0;
        const maxQty = Math.max(0, p.qty - inCart);
        return `<div class="product-card ${outOfStock ? 'product-out' : ''}">
          <div class="product-img-wrap">
            <img src="${getPartImage(p)}" alt="${p.name}" onclick="openImagePreview('${getPartImage(p)}', event)" onerror="this.onerror=null;this.src='${makePlaceholderImage(p.name || p.code || 'Spare Part')}';">
            <span class="badge ${st.cls} product-stock-badge">${st.label}</span>
            <span class="badge badge-blue product-cat-badge">${p.category}</span>
          </div>
          <div class="product-body">
            <div class="product-name">${p.name}</div>
            <div class="product-code">${p.code}</div>
            <div class="product-stock-line">คงเหลือ <b>${p.qty}</b> ชิ้น · ${p.location || '-'}</div>
            ${inCart > 0 ? `<div class="in-cart-pill">🛒 ในตะกร้า ${inCart} ชิ้น</div>` : ''}
            <div class="product-footer">
              ${outOfStock ? `<button class="btn btn-outline btn-sm add-cart-btn" disabled>หมดสต็อก</button>` : `
              <div class="quantity-control">
                <span>จำนวนเบิก</span>
                <div class="qty-stepper">
                  <button type="button" onclick="stepShopQty(${p.id}, -1)">−</button>
                  <input type="number" id="shop-qty-${p.id}" value="1" min="1" max="${maxQty}" aria-label="จำนวนเบิก ${p.name}">
                  <button type="button" onclick="stepShopQty(${p.id}, 1)">+</button>
                </div>
              </div>
              <button class="btn btn-primary btn-sm add-cart-btn" ${maxQty === 0 ? 'disabled' : ''} onclick="addToCart(${p.id})">🛒 ใส่ตะกร้า</button>
              `}
            </div>
          </div>
        </div>`;
      }).join('');
}

function stepShopQty(partId, delta) {
  const input = document.getElementById(`shop-qty-${partId}`);
  if (!input) return;
  const max = parseInt(input.max) || 1;
  let val = (parseInt(input.value) || 1) + delta;
  val = Math.max(1, Math.min(max, val));
  input.value = val;
}

function addToCart(partId) {
  if (!currentUser || currentUser.role === 'Guest') {
    showLoginPrompt();
    return;
  }
  const p = parts.find(x => x.id === partId);
  if (!p) return;
  const input = document.getElementById(`shop-qty-${partId}`);
  const addQty = Math.max(1, parseInt(input?.value) || 1);
  const already = cartQtyFor(partId);
  const available = p.qty - already;
  if (available <= 0) { toast('สต็อกไม่พอสำหรับอะไหล่นี้แล้ว', 'error'); return; }
  const finalQty = Math.min(addQty, available);

  const existing = cart.find(c => c.partId === partId);
  if (existing) existing.qty += finalQty;
  else cart.push({ partId, qty: finalQty });

  saveCart();
  updateCartBadge();
  renderShop();
  toast(`ใส่ "${p.name}" ${finalQty} ชิ้น ลงตะกร้าแล้ว`, 'success');
}

// ===== CART / CHECKOUT =====
function renderCart() {
  const list = document.getElementById('cart-list');
  const emptyState = document.getElementById('cart-empty');
  const summary = document.getElementById('cart-summary');
  const checkoutForm = document.getElementById('cart-checkout-form');
  if (!list) return;

  // drop any cart lines whose part no longer exists
  cart = cart.filter(c => parts.some(p => p.id === c.partId));
  saveCart();

  if (cart.length === 0) {
    list.innerHTML = '';
    if (emptyState) emptyState.classList.remove('hidden');
    if (summary) summary.classList.add('hidden');
    if (checkoutForm) checkoutForm.classList.add('hidden');
    updateCartBadge();
    return;
  }

  if (emptyState) emptyState.classList.add('hidden');
  if (summary) summary.classList.remove('hidden');
  if (checkoutForm) checkoutForm.classList.remove('hidden');

  list.innerHTML = cart.map(c => {
    const p = parts.find(x => x.id === c.partId);
    if (!p) return '';
    const st = getStockStatus(p);
    return `<div class="cart-row">
      <img src="${getPartImage(p)}" alt="${p.name}" onerror="this.onerror=null;this.src='${makePlaceholderImage(p.name || p.code || 'Spare Part')}';">
      <div class="cart-row-info">
        <div class="cart-row-name">${p.name}</div>
        <div class="cart-row-meta">${p.code} · คงเหลือในคลัง ${p.qty} <span class="badge ${st.cls}" style="margin-left:6px">${st.label}</span></div>
      </div>
      <div class="cart-row-actions">
        <div class="quantity-control cart-quantity-control">
          <span>จำนวนเบิก</span>
          <div class="qty-stepper">
          <button type="button" onclick="stepCartQty(${p.id}, -1)">−</button>
          <input type="number" value="${c.qty}" min="1" max="${p.qty}" aria-label="จำนวนเบิก ${p.name}" onchange="setCartQty(${p.id}, this.value)">
          <button type="button" onclick="stepCartQty(${p.id}, 1)">+</button>
          </div>
        </div>
        <button class="btn btn-danger btn-sm" onclick="removeFromCart(${p.id})">🗑</button>
      </div>
    </div>`;
  }).join('');

  document.getElementById('cart-total-count').textContent = cartTotalItems();
  updateCartBadge();
}

function stepCartQty(partId, delta) {
  const p = parts.find(x => x.id === partId);
  const c = cart.find(x => x.partId === partId);
  if (!p || !c) return;
  c.qty = Math.max(1, Math.min(p.qty, c.qty + delta));
  saveCart();
  renderCart();
}

function setCartQty(partId, value) {
  const p = parts.find(x => x.id === partId);
  const c = cart.find(x => x.partId === partId);
  if (!p || !c) return;
  let qty = parseInt(value) || 1;
  qty = Math.max(1, Math.min(p.qty, qty));
  c.qty = qty;
  saveCart();
  renderCart();
}

function removeFromCart(partId) {
  cart = cart.filter(c => c.partId !== partId);
  saveCart();
  renderCart();
  renderShop();
  toast('นำออกจากตะกร้าแล้ว', 'info');
}

function clearCart() {
  if (cart.length === 0) return;
  const ok = window.confirm('ล้างตะกร้าทั้งหมดใช่หรือไม่?');
  if (!ok) return;
  cart = [];
  saveCart();
  renderCart();
  renderShop();
  toast('ล้างตะกร้าแล้ว', 'info');
}

async function checkoutCart() {
  if (!currentUser || currentUser.role === 'Guest') {
    showLoginPrompt();
    return;
  }
  if (!canAccessAction('withdraw')) {
    toast('คุณไม่มีสิทธิ์เบิกอะไหล่ โปรดติดต่อ Admin', 'error');
    return;
  }
  if (cart.length === 0) { toast('ตะกร้าว่างเปล่า', 'error'); return; }

  const withdrawer = document.getElementById('cart-withdrawer').value.trim();
  const date = document.getElementById('cart-date').value;
  const approverSelect = document.getElementById('cart-approver');
  const approverUid = approverSelect.value;
  const approver = approverSelect.options[approverSelect.selectedIndex]?.textContent || '';
  const machine = document.getElementById('cart-machine').value.trim();

  if (!withdrawer || !date || !machine || !approverUid) {
    toast('กรุณากรอกข้อมูลผู้เบิก วันที่ และเครื่องจักรให้ครบ', 'error');
    return;
  }

  // validate stock for every line before committing anything
  for (const c of cart) {
    const p = parts.find(x => x.id === c.partId);
    if (!p) { toast('พบรายการอะไหล่ที่ไม่มีอยู่แล้วในตะกร้า กรุณาลองใหม่', 'error'); return; }
    if (c.qty > p.qty) { toast(`สต็อก "${p.name}" ไม่พอ คงเหลือเพียง ${p.qty} ชิ้น`, 'error'); return; }
  }

  let nextHistId = history.length ? Math.max(...history.map(h => h.id)) + 1 : 1;
  const itemNames = [];
  cart.forEach(c => {
    const p = parts.find(x => x.id === c.partId);
    history.push({ id: nextHistId++, date, requestedAt: new Date().toISOString(), partId: p.id, partCode: p.code, partName: p.name, qty: c.qty, image: p.image || '', withdrawer, machine, approver, approverUid, status: 'pending' });
    itemNames.push(`${p.name} x${c.qty}`);
  });

  try {
    await saveData(parts, history);
  } catch (error) {
    toast(error.message || 'ส่งคำขอเบิกไม่สำเร็จ', 'error');
    return;
  }
  cart = [];
  saveCart();

  updateAlerts();
  renderShop();
  renderCart();
  renderInventory();
  renderLowStock();
  renderDashboard();
  renderHistory();
  clearCartCheckoutForm();

  toast(`ส่งคำขอเบิกแล้ว รอ ${approver} อนุมัติ: ${itemNames.join(', ')}`, 'success');
  navigate('history');
}

function clearCartCheckoutForm() {
  document.getElementById('cart-withdrawer').value = '';
  document.getElementById('cart-machine').value = '';
  document.getElementById('cart-date').value = new Date().toISOString().split('T')[0];
}

// ===== INVENTORY (admin table) =====
function renderInventory() {
  const q = (document.getElementById('inv-search').value || '').toLowerCase();
  const cat = document.getElementById('inv-cat').value;

  const cats = [...new Set(parts.map(p => p.category))].sort();
  const catSel = document.getElementById('inv-cat');
  const curCat = catSel.value;
  catSel.innerHTML = '<option value="">ทุกประเภท</option>' + cats.map(c => `<option value="${c}" ${c===curCat?'selected':''}>${c}</option>`).join('');

  const filtered = parts.filter(p =>
    (!q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q)) &&
    (!cat || p.category === cat)
  );

  const tbody = document.getElementById('inv-tbody');
  tbody.innerHTML = filtered.length === 0
    ? `<tr><td colspan="10"><div class="empty"><div class="empty-icon">📦</div>ไม่พบรายการ</div></td></tr>`
    : filtered.map(p => {
        const st = getStockStatus(p);
        return `<tr>
          <td><span style="font-family:var(--mono);font-size:12px;color:var(--accent)">${p.code}</span></td>
          <td><img class="thumb" src="${getPartImage(p)}" alt="${p.name}" onclick="openImagePreview('${getPartImage(p)}', event)" onerror="this.onerror=null;this.src='${makePlaceholderImage(p.name || p.code || 'Spare Part')}';"></td>
          <td>${p.name}</td>
          <td><span class="badge badge-blue">${p.category}</span></td>
          <td style="font-family:var(--mono);font-weight:700">${p.qty}</td>
          <td style="color:var(--muted)">${p.minQty}</td>
          <td><span class="badge ${st.cls}">${st.label}</span></td>
          <td style="color:var(--muted)">${p.location}</td>
          <td style="color:var(--muted);font-size:12px">${formatDisplayDate(p.updated)}</td>
          <td>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn btn-outline btn-sm" onclick="openEditPart(${p.id})">✏️ แก้ไข</button>
              <button class="btn btn-danger btn-sm" onclick="deletePart(${p.id})">🗑️ ลบ</button>
            </div>
          </td>
        </tr>`;
      }).join('');
}

function openAddPart() {
  if (!canAccessAction('receive')) {
    toast('คุณไม่มีสิทธิ์เพิ่มอะไหล่ใหม่ โปรดติดต่อ Admin', 'error');
    return;
  }

  editingPartId = null;
  document.getElementById('edit-modal-title').textContent = '➕ เพิ่มอะไหล่ใหม่';
  document.getElementById('edit-name').value = '';
  document.getElementById('edit-code').value = '';
  document.getElementById('edit-category').value = 'Bearing';
  document.getElementById('edit-qty').value = '0';
  document.getElementById('edit-unit-price').value = '0';
  document.getElementById('edit-minqty').value = '5';
  document.getElementById('edit-location').value = '';
  document.getElementById('edit-image-url').value = '';
  document.getElementById('edit-image-file').value = '';
  document.getElementById('edit-image-preview').innerHTML = 'ไม่มีรูปภาพ';
  document.getElementById('edit-modal-bg').classList.add('open');
}

function openEditPart(id) {
  if (!canAccessAction('receive')) {
    toast('คุณไม่มีสิทธิ์แก้ไขข้อมูลอะไหล่ โปรดติดต่อ Admin', 'error');
    return;
  }

  const p = parts.find(x => x.id === id);
  if (!p) return;
  editingPartId = id;
  document.getElementById('edit-modal-title').textContent = '✏️ แก้ไขข้อมูลอะไหล่';
  document.getElementById('edit-name').value = p.name;
  document.getElementById('edit-code').value = p.code;
  document.getElementById('edit-category').value = p.category;
  document.getElementById('edit-qty').value = p.qty;
  document.getElementById('edit-unit-price').value = Number(p.unitPrice || 0);
  document.getElementById('edit-minqty').value = p.minQty;
  document.getElementById('edit-location').value = p.location;
  document.getElementById('edit-image-url').value = isGeneratedPlaceholderImage(p.image) ? '' : (p.image || '');
  document.getElementById('edit-image-file').value = '';
  const preview = document.getElementById('edit-image-preview');
  preview.innerHTML = `<img src="${getPartImage(p)}" alt="${p.name}" onerror="this.onerror=null;this.src='${makePlaceholderImage(p.name || p.code || 'Spare Part')}';">`;
  document.getElementById('edit-modal-bg').classList.add('open');
}

function closeEditModal() {
  editingPartId = null;
  document.getElementById('edit-modal-bg').classList.remove('open');
}

async function saveEditedPart() {
  if (!canAccessAction('receive')) {
    toast('คุณไม่มีสิทธิ์บันทึกข้อมูลอะไหล่ โปรดติดต่อ Admin', 'error');
    return;
  }

  const name = document.getElementById('edit-name').value.trim();
  const code = document.getElementById('edit-code').value.trim();
  const category = document.getElementById('edit-category').value;
  const qty = parseInt(document.getElementById('edit-qty').value, 10);
  const minQty = parseInt(document.getElementById('edit-minqty').value, 10);
  const unitPrice = parseFloat(document.getElementById('edit-unit-price').value) || 0;
  const location = document.getElementById('edit-location').value.trim();
  const imageUrl = document.getElementById('edit-image-url').value.trim();
  const imageFile = document.getElementById('edit-image-file').files[0];

  if (!name || !code || !location) {
    toast('กรุณากรอกชื่อ รหัส และที่เก็บให้ครบ', 'error');
    return;
  }
  if (isNaN(qty) || qty < 0 || isNaN(minQty) || minQty < 0) {
    toast('จำนวนและขั้นต่ำต้องเป็นตัวเลขที่ถูกต้อง', 'error');
    return;
  }

  const duplicate = parts.find(p => p.id !== editingPartId && p.code.toLowerCase() === code.toLowerCase());
  if (duplicate) {
    toast('รหัสอะไหล่ซ้ำกับรายการที่มีอยู่แล้ว', 'error');
    return;
  }

  const finishSave = async (imageValue) => {
    const finalImageValue = imageValue && looksLikeImageReference(imageValue) ? imageValue : (imageValue && imageValue.startsWith('data:image/') ? imageValue : '');

    if (editingPartId) {
      const p = parts.find(x => x.id === editingPartId);
      if (!p) return;
      p.name = name;
      p.code = code;
      p.category = category;
      p.qty = qty;
      p.unitPrice = unitPrice;
      p.minQty = minQty;
      p.location = location;
      p.image = finalImageValue || p.image || '';
      p.updated = new Date().toISOString().split('T')[0];
      toast(`อัปเดตข้อมูล "${name}" สำเร็จ`, 'success');
    } else {
      const newId = parts.length ? Math.max(...parts.map(p => p.id)) + 1 : 1;
      const newPart = { id: newId, code, name, category, qty, minQty, location, updated: new Date().toISOString().split('T')[0], image: finalImageValue };
      parts.push(newPart);
      toast(`เพิ่ม "${name}" เข้าคลังสำเร็จ`, 'success');
    }

    await saveData(parts, history);
    updateAlerts();
    renderInventory();
    renderShop();
    renderLowStock();
    renderDashboard();
    renderHistory();
    closeEditModal();
  };

  try {
    const uploadedImageUrl = imageFile ? await uploadImageToFirebaseStorage(imageFile) : '';
    await finishSave(uploadedImageUrl || imageUrl);
  } catch (error) {
    toast(error.message || 'บันทึกข้อมูลไม่สำเร็จ', 'error');
  }
}

function deletePart(id) {
  if (!canAccessAction('receive')) {
    toast('คุณไม่มีสิทธิ์ลบข้อมูลอะไหล่ โปรดติดต่อ Admin', 'error');
    return;
  }

  const p = parts.find(x => x.id === id);
  if (!p) return;
  const ok = window.confirm(`ลบรายการ ${p.name} ออกจากคลังใช่หรือไม่`);
  if (!ok) return;

  parts = parts.filter(x => x.id !== id);
  history = history.filter(h => h.partId !== id);
  cart = cart.filter(c => c.partId !== id);
  saveCart();
  saveData(parts, history);
  updateAlerts();
  renderInventory();
  renderShop();
  renderCart();
  renderLowStock();
  renderDashboard();
  renderHistory();
  toast(`ลบ ${p.name} ออกจากคลังเรียบร้อยแล้ว`, 'success');
}

// ===== RECEIVE =====
async function receivePart() {
  if (!canAccessAction('receive')) {
    toast('คุณไม่มีสิทธิ์รับอะไหล่เข้า โปรดติดต่อ Admin', 'error');
    return;
  }

  const name = document.getElementById('r-name').value.trim();
  const code = document.getElementById('r-code').value.trim();
  const category = document.getElementById('r-category').value;
  const qty = parseInt(document.getElementById('r-qty').value);
  const minQty = parseInt(document.getElementById('r-minqty').value) || 5;
  const location = document.getElementById('r-location').value.trim();
  const unitPrice = parseFloat(document.getElementById('r-unit-price').value);
  const receiver = document.getElementById('r-receiver').value.trim();
  const date = document.getElementById('r-date').value;
  const imageUrl = document.getElementById('r-image-url').value.trim();
  const imageFile = document.getElementById('r-image-file').files[0];

  if (!name || !code || !qty || !location || !receiver || !date || isNaN(unitPrice) || unitPrice < 0) {
    toast('กรุณากรอกข้อมูลให้ครบถ้วน', 'error'); return;
  }
  if (isNaN(qty) || qty < 1) { toast('จำนวนต้องมากกว่า 0', 'error'); return; }

  const existing = parts.find(p => p.code === code);

  const finishSave = async (imageValue) => {
    let finalImageValue = existing ? (existing.image || '') : '';
    if (imageValue && (imageValue.startsWith('data:image/') || looksLikeImageReference(imageValue))) {
      finalImageValue = imageValue;
    }

    if (existing) {
      const previousValue = existing.qty * Number(existing.unitPrice || 0);
      existing.qty += qty;
      existing.unitPrice = (previousValue + (qty * unitPrice)) / existing.qty;
      existing.updated = date;
      existing.image = finalImageValue;
      toast(`เติมสต็อก "${existing.name}" +${qty} ชิ้น (คงเหลือ ${existing.qty})`, 'success');
    } else {
      const newId = parts.length ? Math.max(...parts.map(p => p.id)) + 1 : 1;
      const newPart = { id: newId, code, name, category, qty, minQty, location, unitPrice, updated: date, image: finalImageValue };
      parts.push(newPart);
      toast(`เพิ่ม "${name}" เข้าคลังสำเร็จ`, 'success');
    }

    receipts.push({ id: `${Date.now()}-${code}`, date, receivedAt: new Date().toISOString(), receiver, partId: existing?.id || parts.find(item => item.code === code)?.id, partCode: code, partName: existing?.name || name, qty, unitPrice, total: qty * unitPrice });
    await saveData(parts, history);
    updateAlerts();
    renderInventory();
    renderShop();
    renderLowStock();
    renderDashboard();
    clearReceiveForm();
  };

  try {
    const uploadedImageUrl = imageFile ? await uploadImageToFirebaseStorage(imageFile) : '';
    await finishSave(uploadedImageUrl || imageUrl);
  } catch (error) {
    toast(error.message || 'บันทึกรับเข้าไม่สำเร็จ', 'error');
  }
}

function clearReceiveForm() {
  ['r-name','r-code','r-qty','r-location','r-receiver','r-image-url','r-unit-price'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('r-image-file').value = '';
  document.getElementById('r-image-preview').innerHTML = 'ไม่มีรูปภาพ';
  document.getElementById('r-minqty').value = '5';
  document.getElementById('r-date').value = new Date().toISOString().split('T')[0];
}

// ===== APPROVALS / HISTORY =====
function getHistoryStatus(entry) {
  if (entry.status === 'pending') return { label: 'รออนุมัติ', cls: 'badge-amber' };
  if (entry.status === 'rejected') return { label: 'ไม่อนุมัติ', cls: 'badge-red' };
  return { label: 'อนุมัติแล้ว', cls: 'badge-green' };
}

async function approveWithdrawal(id) {
  if (!currentUser || currentUser.role !== 'Admin') {
    toast('เฉพาะ Admin เท่านั้นที่อนุมัติได้', 'error');
    return;
  }
  const entry = history.find(item => item.id === id);
  if (!entry || entry.status !== 'pending') return;
  const part = parts.find(item => item.id === entry.partId);
  if (!part || entry.qty > part.qty) {
    toast(`สต็อกของ ${entry.partName} ไม่เพียงพอ`, 'error');
    return;
  }
  part.qty -= entry.qty;
  part.updated = entry.date;
  entry.status = 'approved';
  entry.approvedBy = currentUser.name;
  entry.approvedAt = new Date().toISOString();
  try {
    await saveData(parts, history);
    renderApprovalRequests();
    renderHistory();
    renderInventory();
    renderShop();
    renderLowStock();
    renderDashboard();
    toast(`อนุมัติการเบิก ${entry.partName} แล้ว`, 'success');
  } catch (error) {
    toast(error.message || 'อนุมัติไม่สำเร็จ', 'error');
  }
}

async function rejectWithdrawal(id) {
  if (!currentUser || currentUser.role !== 'Admin') {
    toast('เฉพาะ Admin เท่านั้นที่ไม่อนุมัติได้', 'error');
    return;
  }
  const entry = history.find(item => item.id === id);
  if (!entry || entry.status !== 'pending') return;
  entry.status = 'rejected';
  entry.approvedBy = currentUser.name;
  entry.approvedAt = new Date().toISOString();
  try {
    await saveData(parts, history);
    renderApprovalRequests();
    renderHistory();
    toast(`ไม่อนุมัติการเบิก ${entry.partName}`, 'info');
  } catch (error) {
    toast(error.message || 'ไม่อนุมัติไม่สำเร็จ', 'error');
  }
}

function renderApprovalRequests() {
  const card = document.getElementById('pending-withdrawals-card');
  const list = document.getElementById('pending-withdrawals-list');
  const count = document.getElementById('pending-count');
  if (!card || !list || !count) return;
  const pending = history.filter(entry => entry.status === 'pending');
  count.textContent = `${pending.length} รายการ`;
  card.classList.toggle('hidden', currentUser?.role !== 'Admin' || pending.length === 0);
  list.innerHTML = pending.map(entry => { const part = parts.find(item => item.id === entry.partId); const image = entry.image || part?.image || ''; return `<div class="rec-item approval-request">
    <img class="approval-image" src="${getPartImage({ image, name: entry.partName })}" alt="${entry.partName}" onerror="this.onerror=null;this.src='${makePlaceholderImage(entry.partName)}';">
    <div class="rec-body">
      <div class="rec-title">${entry.partName} x${entry.qty}</div>
      <div class="rec-desc">ผู้เบิก: ${entry.withdrawer} · เครื่องจักร: ${entry.machine}</div>
      <div class="rec-desc">ขอเบิก: ${formatDisplayDateTime(entry.requestedAt || entry.date)}</div>
    </div>
    <div class="btn-row">
      <button class="btn btn-success btn-sm" onclick="approveWithdrawal(${entry.id})">อนุมัติ</button>
      <button class="btn btn-danger btn-sm" onclick="rejectWithdrawal(${entry.id})">ไม่อนุมัติ</button>
    </div>
  </div>`; }).join('');
}

function renderHistory() {
  const q = (document.getElementById('hist-search').value || '').toLowerCase();
  const from = document.getElementById('hist-date-from').value;
  const to = document.getElementById('hist-date-to').value;
  const machine = document.getElementById('hist-machine').value;

  const machines = [...new Set(history.map(h => h.machine))].sort();
  const macSel = document.getElementById('hist-machine');
  const curMac = macSel.value;
  macSel.innerHTML = '<option value="">ทุกเครื่องจักร</option>' + machines.map(m => `<option value="${m}" ${m===curMac?'selected':''}>${m}</option>`).join('');

  const filtered = [...history].filter(h =>
    (!q || h.partName.toLowerCase().includes(q) || h.partCode.toLowerCase().includes(q) || h.machine.toLowerCase().includes(q) || h.withdrawer.toLowerCase().includes(q)) &&
    (!from || h.date >= from) && (!to || h.date <= to) &&
    (!machine || h.machine === machine)
  ).sort((a,b) => b.date.localeCompare(a.date));

  renderApprovalRequests();
  const tbody = document.getElementById('hist-tbody');
  tbody.innerHTML = filtered.length === 0
    ? `<tr><td colspan="10"><div class="empty"><div class="empty-icon">📋</div>ไม่พบประวัติ</div></td></tr>`
    : filtered.map((h,i) => { const status = getHistoryStatus(h); return `<tr>
        <td style="color:var(--muted)">${i+1}</td>
        <td>${formatDisplayDate(h.date)}<br><small>${formatDisplayDateTime(h.requestedAt)}</small></td>
        <td style="font-family:var(--mono);font-size:12px;color:var(--accent)">${h.partCode}</td>
        <td>${h.partName}</td>
        <td><span class="badge badge-amber">${h.qty}</span></td>
        <td>${h.withdrawer}</td>
        <td style="font-family:var(--mono);font-size:12px">${h.machine}</td>
        <td style="color:var(--muted)">${h.approver}</td>
        <td><span class="badge ${status.cls}">${status.label}</span></td>
        <td>${formatDisplayDateTime(h.approvedAt)}</td>
      </tr>`; }).join('');
}

// ===== LOW STOCK =====
function renderLowStock() {
  const low = getLowStockParts();
  document.getElementById('lowstock-count').textContent = `${low.length} รายการ`;
  const tbody = document.getElementById('ls-tbody');
  tbody.innerHTML = low.length === 0
    ? `<tr><td colspan="8"><div class="empty"><div class="empty-icon">✅</div>ทุกรายการมีสต็อกเพียงพอ</div></td></tr>`
    : low.map(p => {
        const st = getStockStatus(p);
        return `<tr>
          <td style="font-family:var(--mono);font-size:12px;color:var(--accent)">${p.code}</td>
          <td>${p.name}</td>
          <td><span class="badge badge-blue">${p.category}</span></td>
          <td style="font-family:var(--mono);font-weight:700;color:var(--red)">${p.qty}</td>
          <td style="color:var(--muted)">${p.minQty}</td>
          <td style="color:var(--muted)">${p.location}</td>
          <td><span class="badge ${st.cls}">${st.label}</span></td>
          <td><button class="btn btn-outline btn-sm" onclick="openRestock(${p.id})">🛒 สั่งซื้อ</button></td>
        </tr>`;
      }).join('');
}

function openRestock(id) {
  const p = parts.find(x => x.id === id);
  if (!p) return;
  modalPartId = id;
  document.getElementById('modal-part-name').value = `${p.name} (${p.code}) — คงเหลือ ${p.qty}`;
  document.getElementById('modal-qty').value = '';
  document.getElementById('modal-bg').classList.add('open');
}
function closeModal() { document.getElementById('modal-bg').classList.remove('open'); modalPartId = null; }
function confirmRestock() {
  const qty = parseInt(document.getElementById('modal-qty').value);
  if (!qty || qty < 1) { toast('กรุณาระบุจำนวน', 'error'); return; }
  const p = parts.find(x => x.id === modalPartId);
  if (!p) return;
  p.qty += qty;
  p.updated = new Date().toISOString().split('T')[0];
  saveData(parts, history);
  updateAlerts();
  renderShop();
  toast(`เติมสต็อก "${p.name}" +${qty} ชิ้น`, 'success');
  closeModal();
  renderLowStock();
}

// ===== RECOMMENDATIONS =====
function renderRecommendations() {
  const pairs = {};
  const machineFreq = {};
  const approvedHistory = history.filter(entry => !entry.status || entry.status === 'approved');
  const usageByPart = {};
  approvedHistory.forEach(entry => {
    usageByPart[entry.partId] = (usageByPart[entry.partId] || 0) + Number(entry.qty || 0);
  });

  const topUsageList = document.getElementById('rec-top-usage-list');
  const topUsage = Object.entries(usageByPart)
    .map(([partId, qty]) => ({ part: parts.find(item => String(item.id) === String(partId)), qty }))
    .filter(item => item.part)
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 5);
  topUsageList.innerHTML = topUsage.length ? topUsage.map(item => `<div class="rec-item">
    <div class="rec-icon" style="background:rgba(217,119,6,0.1);color:var(--amber)">↗</div>
    <div class="rec-body"><div class="rec-title">${item.part.name}</div><div class="rec-desc">เบิกแล้ว ${item.qty} ชิ้น · คงเหลือ ${item.part.qty}</div></div>
  </div>`).join('') : '<div class="empty">ยังไม่มีข้อมูลการเบิก</div>';

  const reorderList = document.getElementById('rec-reorder-list');
  const reorderParts = parts.filter(part => part.qty <= part.minQty).sort((a, b) => (a.qty - a.minQty) - (b.qty - b.minQty)).slice(0, 5);
  reorderList.innerHTML = reorderParts.length ? reorderParts.map(part => {
    const suggested = Math.max(part.minQty * 2 - part.qty, part.minQty || 1);
    return `<div class="rec-item"><div class="rec-icon" style="background:rgba(220,38,38,0.1);color:var(--red)">!</div>
      <div class="rec-body"><div class="rec-title">${part.name}</div><div class="rec-desc">เหลือ ${part.qty} ชิ้น · แนะนำเติมอย่างน้อย ${suggested} ชิ้น</div></div></div>`;
  }).join('') : '<div class="empty">สต็อกอยู่ในระดับปกติ</div>';

  const receiptList = document.getElementById('rec-recent-receipts-list');
  const recentReceipts = [...receipts].sort((a, b) => String(b.receivedAt || b.date).localeCompare(String(a.receivedAt || a.date))).slice(0, 5);
  receiptList.innerHTML = recentReceipts.length ? recentReceipts.map(item => `<div class="rec-item">
    <div class="rec-icon" style="background:rgba(22,163,74,0.1);color:var(--green)">+</div>
    <div class="rec-body"><div class="rec-title">${item.partName} +${item.qty} ชิ้น</div><div class="rec-desc">฿${Number(item.total || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 })} · ${formatDisplayDateTime(item.receivedAt || item.date)}</div></div>
  </div>`).join('') : '<div class="empty">ยังไม่มีข้อมูลรับเข้า</div>';

  approvedHistory.forEach(h => {
    const key = `${h.machine}|${h.date}`;
    if (!machineFreq[h.machine]) machineFreq[h.machine] = {};
    machineFreq[h.machine][h.partCode] = (machineFreq[h.machine][h.partCode] || 0) + 1;
  });

  const bySession = {};
  approvedHistory.forEach(h => {
    const k = `${h.date}|${h.machine}`;
    if (!bySession[k]) bySession[k] = [];
    bySession[k].push(h.partName);
  });
  const pairCount = {};
  Object.values(bySession).forEach(arr => {
    for (let i = 0; i < arr.length; i++) for (let j = i+1; j < arr.length; j++) {
      const k = [arr[i],arr[j]].sort().join(' + ');
      pairCount[k] = (pairCount[k] || 0) + 1;
    }
  });

  const topPairs = Object.entries(pairCount).sort((a,b) => b[1]-a[1]).slice(0,5);
  const pairList = document.getElementById('rec-pair-list');
  pairList.innerHTML = topPairs.length === 0
    ? '<div class="empty"><div class="empty-icon">🔗</div>ยังไม่มีข้อมูลเพียงพอ</div>'
    : topPairs.map(([k,n]) => `<div class="rec-item">
        <div class="rec-icon" style="background:var(--accent-soft);color:var(--accent)">🔗</div>
        <div class="rec-body">
          <div class="rec-title">${k}</div>
          <div class="rec-desc">มักเบิกพร้อมกัน ${n} ครั้ง</div>
        </div>
      </div>`).join('');

  const machineList = document.getElementById('rec-machine-list');
  const topMachines = Object.entries(machineFreq)
    .map(([m, parts]) => ({ machine: m, top: Object.entries(parts).sort((a,b) => b[1]-a[1])[0] }))
    .filter(x => x.top).sort((a,b) => b.top[1]-a.top[1]).slice(0,5);
  machineList.innerHTML = topMachines.length === 0
    ? '<div class="empty"><div class="empty-icon">⚙️</div>ยังไม่มีข้อมูลเพียงพอ</div>'
    : topMachines.map(x => `<div class="rec-item">
        <div class="rec-icon" style="background:rgba(59,130,246,0.12);color:var(--accent2)">⚙️</div>
        <div class="rec-body">
          <div class="rec-title">${x.machine}</div>
          <div class="rec-desc">ใช้ <b>${x.top[0]}</b> บ่อยที่สุด (${x.top[1]} ครั้ง)</div>
        </div>
      </div>`).join('');

  const adviceList = document.getElementById('rec-advice-list');
  const low = getLowStockParts();
  const highFreqLow = low.filter(p => {
    const freq = approvedHistory.filter(h => h.partCode === p.code).reduce((s,h) => s+h.qty, 0);
    return freq > 0;
  });
  const advices = [
    ...highFreqLow.map(p => ({
      icon:'🔴', color:'var(--red)', bg:'rgba(220,38,38,0.08)',
      title:`${p.name} — สต็อกต่ำแต่มีการเบิกสูง`,
      desc:`คงเหลือ ${p.qty} ชิ้น (ต่ำกว่าขั้นต่ำ ${p.minQty}) ควรสั่งซื้อโดยด่วน`
    })),
    ...(topMachines.slice(0,2).map(x => ({
      icon:'⚙️', color:'var(--accent2)', bg:'rgba(59,130,246,0.08)',
      title:`${x.machine} — ควรตรวจสอบเชิงป้องกัน`,
      desc:`เครื่องนี้มีประวัติเบิก ${x.top[0]} บ่อย แนะนำให้ตั้ง PM schedule`
    }))),
    { icon:'💡', color:'var(--amber)', bg:'rgba(217,119,6,0.08)',
      title:'เชื่อมกับระบบ PM', desc:'ข้อมูลการเบิกอะไหล่สามารถนำไปเชื่อมกับระบบ Preventive Maintenance เพื่อคำนวณต้นทุนการซ่อมบำรุงต่อเครื่องได้' }
  ];
  adviceList.innerHTML = advices.map(a => `<div class="rec-item">
    <div class="rec-icon" style="background:${a.bg};color:${a.color}">${a.icon}</div>
    <div class="rec-body">
      <div class="rec-title">${a.title}</div>
      <div class="rec-desc">${a.desc}</div>
    </div>
  </div>`).join('');
}

// ===== EXPORT =====
function exportExcel() {
  const rows = [['รหัส','ชื่ออะไหล่','ประเภท','จำนวน','ขั้นต่ำ','ที่เก็บ','อัปเดต']];
  parts.forEach(p => rows.push([p.code, p.name, p.category, p.qty, p.minQty, p.location, p.updated]));
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'คลังอะไหล่');
  XLSX.writeFile(wb, 'spare_parts_inventory.xlsx');
  toast('Export Excel สำเร็จ', 'success');
}

function exportPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.text('Spare Part Inventory', 14, 16);
  doc.autoTable({
    head: [['รหัส','ชื่ออะไหล่','ประเภท','จำนวน','ขั้นต่ำ','ที่เก็บ']],
    body: parts.map(p => [p.code, p.name, p.category, p.qty, p.minQty, p.location]),
    startY: 22
  });
  doc.save('spare_parts_inventory.pdf');
  toast('Export PDF สำเร็จ', 'success');
}

function exportHistoryExcel() {
  const rows = [['#','วันที่','รหัส','ชื่ออะไหล่','จำนวน','คนเบิก','เครื่องจักร','ผู้อนุมัติ']];
  [...history].sort((a,b) => b.date.localeCompare(a.date)).forEach((h,i) =>
    rows.push([i+1, h.date, h.partCode, h.partName, h.qty, h.withdrawer, h.machine, h.approver]));
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'ประวัติการเบิก');
  XLSX.writeFile(wb, 'withdrawal_history.xlsx');
  toast('Export Excel สำเร็จ', 'success');
}

function exportHistoryPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.text('Withdrawal History', 14, 16);
  doc.autoTable({
    head: [['วันที่','รหัส','ชื่ออะไหล่','จำนวน','คนเบิก','เครื่องจักร']],
    body: [...history].sort((a,b) => b.date.localeCompare(a.date)).map(h => [h.date, h.partCode, h.partName, h.qty, h.withdrawer, h.machine]),
    startY: 22
  });
  doc.save('withdrawal_history.pdf');
  toast('Export PDF สำเร็จ', 'success');
}

// ===== INIT =====
document.getElementById('current-date').textContent = new Date().toLocaleDateString('th-TH', { weekday:'short', year:'numeric', month:'long', day:'numeric' });
document.getElementById('r-date').value = new Date().toISOString().split('T')[0];
document.getElementById('cart-date').value = new Date().toISOString().split('T')[0];

function updateImagePreview(previewId, urlInputId, fileInputId) {
  const preview = document.getElementById(previewId);
  if (!preview) return;
  const url = document.getElementById(urlInputId)?.value.trim() || '';
  const file = document.getElementById(fileInputId)?.files[0];
  if (file) {
    readImageFile(file, (data) => {
      preview.innerHTML = data ? `<img src="${data}" alt="preview">` : 'ไม่มีรูปภาพ';
    });
  } else if (url) {
    preview.innerHTML = `<img src="${url}" alt="preview">`;
  } else {
    preview.innerHTML = 'ไม่มีรูปภาพ';
  }
}

['edit-image-url','edit-image-file','r-image-url','r-image-file'].forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('change', () => {
      const previewId = id.startsWith('r-') ? 'r-image-preview' : 'edit-image-preview';
      const urlInputId = id.startsWith('r-') ? 'r-image-url' : 'edit-image-url';
      const fileInputId = id.startsWith('r-') ? 'r-image-file' : 'edit-image-file';
      updateImagePreview(previewId, urlInputId, fileInputId);
    });
  }
});

async function bootstrap() {
  applySavedTheme();
  setLoading(true, 'กำลังตรวจสอบการเข้าสู่ระบบ...');
  auth.onAuthStateChanged(async (user) => {
    try {
      if (!user) {
        currentUser = null;
        await initializeData();
        showApp();
        return;
      }
      const profile = await loadUserProfile(user.uid);
      console.info('Firebase login UID:', user.uid);
      console.info('โหลดโปรไฟล์จาก collection:', profile.profileCollection || 'ไม่พบเอกสาร');
      console.info('ค่า role จาก Firestore:', profile.role || '(ไม่มี role)');
      const normalizedRole = normalizeRole(profile.role);
      const normalizedStatus = String(profile.status || '').trim().toLowerCase();
      console.info('ค่า status จาก Firestore:', JSON.stringify(profile.status), '→ normalized:', normalizedStatus);
      // ถ้าพบ profile ใน Firestore แต่ไม่มี status field → บัญชีสร้างโดย Admin โดยตรง ถือว่า approved
      const hasProfile = !!profile.profileCollection;
      // A Firebase Authentication account without a Firestore profile is still
      // allowed to sign in as a regular User. Pending/rejected profiles remain blocked.
      const isApproved = !hasProfile || normalizedStatus === '' || normalizedStatus === 'approved';
      if (normalizedRole !== 'Admin' && !isApproved) {
        await auth.signOut();
        registrationNotice = normalizedStatus === 'rejected'
          ? 'บัญชีนี้ไม่ได้รับการอนุมัติจาก Admin'
          : !hasProfile
          ? 'ไม่พบข้อมูลบัญชีในระบบ กรุณาติดต่อ Admin'
          : `บัญชีของคุณอยู่ระหว่างรอ Admin อนุมัติ (สถานะ: ${profile.status || 'ไม่มีข้อมูล'})`;
        showLogin();
        return;
      }
      currentUser = { uid: user.uid, email: user.email, name: profile.name || user.email, role: normalizedRole };
      console.info('บทบาทที่ระบบใช้งาน:', currentUser.role);
      localStorage.setItem('sparepart_user', JSON.stringify(currentUser));
      await initializeData();
      await loadApprovers();
      showApp();
    } catch (error) {
      console.error('เริ่มต้นระบบไม่สำเร็จ:', error.code, error.message);
      registrationNotice = `ระบบเริ่มต้นไม่สำเร็จ (${error.code || 'unknown-error'})`;
      showLogin();
    } finally {
      setLoading(false);
    }
  });
}

bootstrap();
