const CONFIG = window.TRIPSYNCH_CONFIG;
const byId = id => document.getElementById(id);
const query = selector => document.querySelector(selector);

const ui = {
  authScreen: byId("authScreen"), homeScreen: byId("homeScreen"), tripScreen: byId("tripScreen"),
  loginForm: byId("loginForm"), signupForm: byId("signupForm"), createTripForm: byId("createTripForm"), joinTripForm: byId("joinTripForm"),
  signedInAs: byId("signedInAs"), tripCards: byId("tripCards"), tripTitle: byId("tripTitle"), syncStatus: byId("syncStatus"),
  stats: byId("stats"), myPosition: byId("myPosition"), expenseForm: byId("expenseForm"), payerChoices: byId("payerChoices"), splitChoices: byId("splitChoices"), expenseList: byId("expenseList"),
  peopleList: byId("peopleList"), detailsList: byId("detailsList"), settlementList: byId("settlementList"), settlementHistory: byId("settlementHistory"),
  inviteOverlay: byId("inviteOverlay"), inviteQrImage: byId("inviteQrImage"), inviteLinkInput: byId("inviteLinkInput"), toastMessage: byId("toastMessage")
};

const state = {
  token: localStorage.getItem("tripsynchAuthToken") || "",
  user: null,
  trip: null,
  memberId: "",
  payerId: "",
  splitIds: new Set(),
  pollTimer: null,
  pendingInviteCode: new URLSearchParams(location.search).get("join")?.toUpperCase() || ""
};

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const formatDate = value => value ? new Date(value).toLocaleString() : "Date unavailable";
const toCents = value => Math.round(Number(value || 0) * 100);
const memberName = id => state.trip?.members.find(member => member.id === id)?.name || "Unknown";
const money = value => new Intl.NumberFormat(undefined, { style: "currency", currency: state.trip?.currency || "INR" }).format(Number(value || 0));

function showToast(message) {
  ui.toastMessage.textContent = message;
  ui.toastMessage.className = "show";
  setTimeout(() => { ui.toastMessage.className = ""; }, 2300);
}

async function api(path, options = {}) {
  const response = await fetch(CONFIG.API_BASE.replace(/\/$/, "") + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...options.headers
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function showScreen(screen) {
  [ui.authScreen, ui.homeScreen, ui.tripScreen].forEach(item => { item.hidden = item !== screen; });
}

function storeSession(data) {
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem("tripsynchAuthToken", data.token);
}

function logout() {
  clearInterval(state.pollTimer);
  state.token = "";
  state.user = null;
  state.trip = null;
  localStorage.removeItem("tripsynchAuthToken");
  location.href = state.pendingInviteCode ? `/?join=${encodeURIComponent(state.pendingInviteCode)}` : "/";
}

function activeMembers() {
  return state.trip.members.filter(member => member.active !== false);
}

function buildBalanceModel() {
  const balances = Object.fromEntries(state.trip.members.map(member => [member.id, { ...member, paid: 0, share: 0, count: 0, balance: 0 }]));
  for (const expense of state.trip.expenses) {
    if (!balances[expense.paidBy] || !expense.splitAmong?.length) continue;
    const total = toCents(expense.amount);
    const base = Math.floor(total / expense.splitAmong.length);
    let remainder = total - base * expense.splitAmong.length;
    balances[expense.paidBy].paid += total;
    balances[expense.paidBy].count += 1;
    for (const memberId of expense.splitAmong) {
      if (!balances[memberId]) continue;
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      balances[memberId].share += base + extra;
    }
  }
  for (const settlement of state.trip.settlements || []) {
    if (settlement.status !== "settled") continue;
    const amount = toCents(settlement.amount);
    if (balances[settlement.from]) balances[settlement.from].paid += amount;
    if (balances[settlement.to]) balances[settlement.to].paid -= amount;
  }
  Object.values(balances).forEach(person => { person.balance = person.paid - person.share; });
  return balances;
}

function buildSettlementPlan(balances) {
  const debtors = Object.values(balances).filter(person => person.active !== false && person.balance < 0).map(person => ({ id: person.id, value: -person.balance }));
  const creditors = Object.values(balances).filter(person => person.active !== false && person.balance > 0).map(person => ({ id: person.id, value: person.balance }));
  const plan = [];
  let debtorIndex = 0, creditorIndex = 0;
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex], creditor = creditors[creditorIndex], amount = Math.min(debtor.value, creditor.value);
    plan.push({ from: debtor.id, to: creditor.id, amount: amount / 100, debt: debtor.value / 100, credit: creditor.value / 100 });
    debtor.value -= amount; creditor.value -= amount;
    if (debtor.value < 1) debtorIndex += 1;
    if (creditor.value < 1) creditorIndex += 1;
  }
  return plan;
}

function expenseShares(expense) {
  if (!expense.splitAmong?.length) return [];
  const total = toCents(expense.amount), base = Math.floor(total / expense.splitAmong.length);
  let remainder = total - base * expense.splitAmong.length;
  return expense.splitAmong.map(memberId => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return { memberId, amount: (base + extra) / 100 };
  });
}

async function loadHome() {
  clearInterval(state.pollTimer);
  const data = await api("/api/trips");
  ui.signedInAs.textContent = `${state.user.name} · ${state.user.email}`;
  ui.tripCards.innerHTML = data.trips.length ? data.trips.map(trip => `
    <article>
      <div class="trip-card-head"><div><h2>${escapeHtml(trip.name)}</h2><small>Code ${trip.code}</small></div><span class="badge">${trip.ownerUserId === state.user.id ? "Owner" : "Member"}</span></div>
      <p>${trip.members.filter(member => member.active !== false).length} active members · ${trip.expenses.length} expenses</p>
      <button type="button" data-open-trip="${trip.id}">Open trip</button>
    </article>`).join("") : "<p>No trips yet. Create one or join with an invite code.</p>";
  showScreen(ui.homeScreen);
}

async function openTrip(tripId, fromPoll = false) {
  try {
    const data = await api(`/api/trips/${tripId}`);
    state.trip = data.trip;
    state.memberId = data.memberId;
    const activeIds = new Set(activeMembers().map(member => member.id));
    if (!activeIds.has(state.payerId)) state.payerId = state.memberId;
    if (!state.splitIds.size) state.splitIds = new Set(activeIds);
    else state.splitIds = new Set([...state.splitIds].filter(id => activeIds.has(id)));
    renderTrip();
    showScreen(ui.tripScreen);
    if (!fromPoll) startPolling();
  } catch (error) {
    showToast(error.message);
    if (error.message.includes("active member")) await loadHome();
  }
}

function renderTrip() {
  const balances = buildBalanceModel();
  const plan = buildSettlementPlan(balances);
  const me = balances[state.memberId];
  const owner = state.trip.ownerUserId === state.user.id;
  const active = activeMembers();
  const total = state.trip.expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);

  ui.tripTitle.textContent = state.trip.name;
  ui.syncStatus.textContent = `Code ${state.trip.code} · Synced ${new Date().toLocaleTimeString()}`;
  ui.stats.innerHTML = `<div class="stat"><span>Total spent</span><b>${money(total)}</b></div><div class="stat"><span>Members</span><b>${active.length}</b></div><div class="stat"><span>Expenses</span><b>${state.trip.expenses.length}</b></div><div class="stat"><span>Open payments</span><b>${plan.length}</b></div>`;
  ui.myPosition.innerHTML = me ? `<article><h2>My position</h2><div class="metrics"><div class="metric"><span>Paid</span><b>${money(me.paid / 100)}</b></div><div class="metric"><span>Share</span><b>${money(me.share / 100)}</b></div><div class="metric"><span>Balance</span><b class="${me.balance >= 0 ? "positive" : "negative"}">${money(me.balance / 100)}</b></div><div class="metric"><span>Status</span><b>${me.balance > 0 ? "Receive" : me.balance < 0 ? "Pay" : "Settled"}</b></div></div></article>` : "";

  ui.payerChoices.innerHTML = active.map(member => `<label class="choice ${member.id === state.payerId ? "selected" : ""}"><input type="radio" name="paidBy" value="${member.id}" ${member.id === state.payerId ? "checked" : ""}>${escapeHtml(member.name)}</label>`).join("");
  ui.splitChoices.innerHTML = active.map(member => `<label class="choice"><input type="checkbox" value="${member.id}" ${state.splitIds.has(member.id) ? "checked" : ""}>${escapeHtml(member.name)}</label>`).join("");

  ui.expenseList.innerHTML = state.trip.expenses.length ? state.trip.expenses.slice().reverse().map(expense => `<div class="row"><span><b>${escapeHtml(expense.description)}</b><small>Paid by ${escapeHtml(memberName(expense.paidBy))}</small><span class="date">Created ${formatDate(expense.createdAt)}</span></span><b>${money(expense.amount)}</b></div>`).join("") : "<p>No expenses yet.</p>";

  ui.peopleList.innerHTML = state.trip.members.map(member => {
    const person = balances[member.id];
    const canManage = owner && member.role !== "owner" && member.active !== false;
    return `<article><div class="person-head"><div><h2>${escapeHtml(member.name)}</h2><small>${escapeHtml(member.email || "")}</small></div>${member.role === "owner" ? '<span class="badge">Owner</span>' : member.active === false ? '<span class="badge removed">Removed</span>' : '<span class="badge">Member</span>'}</div><div class="metrics"><div class="metric"><span>Paid</span><b>${money(person.paid / 100)}</b></div><div class="metric"><span>Share</span><b>${money(person.share / 100)}</b></div><div class="metric"><span>Balance</span><b>${money(person.balance / 100)}</b></div><div class="metric"><span>Expenses paid</span><b>${person.count}</b></div></div><div class="why">${person.balance > 0 ? `Receives ${money(person.balance / 100)} because payments exceed allocated shares.` : person.balance < 0 ? `Pays ${money(-person.balance / 100)} because allocated shares exceed payments.` : "Fully settled."}</div>${canManage ? `<div class="member-actions"><button type="button" data-settle-remove="${member.id}">Settle & remove</button><button type="button" class="secondary" data-remove-member="${member.id}" ${person.balance !== 0 ? "disabled" : ""}>Remove</button></div>` : ""}</article>`;
  }).join("");

  ui.detailsList.innerHTML = state.trip.expenses.length ? state.trip.expenses.map((expense, index) => {
    const shares = expenseShares(expense);
    const explanation = shares.filter(share => share.memberId !== expense.paidBy).map(share => `${escapeHtml(memberName(share.memberId))} owes ${escapeHtml(memberName(expense.paidBy))} ${money(share.amount)}`).join("; ") || "No other member owes for this expense.";
    return `<article><small>EXPENSE ${index + 1}</small><h2>${escapeHtml(expense.description)}</h2><b>${money(expense.amount)} paid by ${escapeHtml(memberName(expense.paidBy))}</b><p class="date">Created ${formatDate(expense.createdAt)}</p>${shares.map(share => `<div class="share"><span>${escapeHtml(memberName(share.memberId))}'s share</span><b>${money(share.amount)}</b></div>`).join("")}<div class="why">${explanation}</div></article>`;
  }).join("") : "<article>No expense details yet.</article>";

  ui.settlementList.innerHTML = plan.length ? plan.map(item => `<div class="payment"><b>${escapeHtml(memberName(item.from))} pays ${escapeHtml(memberName(item.to))} ${money(item.amount)}</b><div class="why">${escapeHtml(memberName(item.from))} owes ${money(item.debt)} and ${escapeHtml(memberName(item.to))} should receive ${money(item.credit)}. The smaller remaining balance is suggested.</div><button type="button" data-mark-settled="${item.from}|${item.to}|${item.amount}">Mark settled</button></div>`).join("") : '<div class="settled">Everyone is settled.</div>';
  ui.settlementHistory.innerHTML = (state.trip.settlements || []).length ? state.trip.settlements.slice().reverse().map(item => `<div class="settled"><b>${escapeHtml(memberName(item.from))} paid ${escapeHtml(memberName(item.to))} ${money(item.amount)}</b><small>${formatDate(item.settledAt)}</small><button type="button" class="secondary" data-undo-settlement="${item.id}">Undo</button></div>`).join("") : "<p>No settlement history.</p>";

  byId("leaveTripButton").hidden = owner;
  byId("deleteTripButton").hidden = !owner;
}

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (state.trip && ui.inviteOverlay.hidden && document.visibilityState === "visible") openTrip(state.trip.id, true);
  }, 5000);
}

function getInviteUrl() {
  return `${CONFIG.APP_URL.replace(/\/$/, "")}?join=${encodeURIComponent(state.trip.code)}`;
}

function openInviteOverlay() {
  ui.inviteLinkInput.value = getInviteUrl();
  ui.inviteQrImage.src = `${CONFIG.API_BASE.replace(/\/$/, "")}/api/qr?text=${encodeURIComponent(ui.inviteLinkInput.value)}`;
  ui.inviteOverlay.hidden = false;
  document.body.classList.add("overlay-open");
}

function closeInviteOverlay() {
  ui.inviteOverlay.hidden = true;
  document.body.classList.remove("overlay-open");
}

async function finishAuthentication(data) {
  storeSession(data);
  if (state.pendingInviteCode) {
    try {
      const joined = await api("/api/trips/join", { method: "POST", body: JSON.stringify({ code: state.pendingInviteCode }) });
      history.replaceState({}, "", "/");
      state.pendingInviteCode = "";
      showToast("Trip joined");
      await openTrip(joined.trip.id);
      return;
    } catch (error) {
      showToast(error.message);
    }
  }
  await loadHome();
}

async function initialize() {
  if (!state.token) {
    showScreen(ui.authScreen);
    if (state.pendingInviteCode) showToast("Login or create an account to join the trip");
    return;
  }
  try {
    const data = await api("/api/auth/me");
    state.user = data.user;
    await finishAuthentication({ token: state.token, user: state.user });
  } catch {
    localStorage.removeItem("tripsynchAuthToken");
    state.token = "";
    showScreen(ui.authScreen);
  }
}

// Authentication
queryAll("[data-auth-mode]").forEach(button => button.addEventListener("click", () => {
  queryAll("[data-auth-mode]").forEach(item => item.classList.toggle("active", item === button));
  ui.loginForm.hidden = button.dataset.authMode !== "login";
  ui.signupForm.hidden = button.dataset.authMode !== "signup";
}));

function queryAll(selector) { return [...document.querySelectorAll(selector)]; }

ui.loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  try { await finishAuthentication(await api("/api/auth/login", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target))) })); }
  catch (error) { showToast(error.message); }
});

ui.signupForm.addEventListener("submit", async event => {
  event.preventDefault();
  try { await finishAuthentication(await api("/api/auth/signup", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target))) })); }
  catch (error) { showToast(error.message); }
});

byId("homeLogoutButton").addEventListener("click", logout);
byId("tripLogoutButton").addEventListener("click", logout);

// Trip home
ui.createTripForm.addEventListener("submit", async event => {
  event.preventDefault();
  try { const data = await api("/api/trips", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); await openTrip(data.trip.id); }
  catch (error) { showToast(error.message); }
});

ui.joinTripForm.addEventListener("submit", async event => {
  event.preventDefault();
  try { const data = await api("/api/trips/join", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); await openTrip(data.trip.id); }
  catch (error) { showToast(error.message); }
});

ui.tripCards.addEventListener("click", event => { if (event.target.dataset.openTrip) openTrip(event.target.dataset.openTrip); });
byId("backToTripsButton").addEventListener("click", loadHome);

// Expense controls
ui.payerChoices.addEventListener("change", event => {
  if (event.target.name !== "paidBy") return;
  state.payerId = event.target.value;
  queryAll("#payerChoices .choice").forEach(label => label.classList.toggle("selected", label.contains(event.target)));
});
ui.splitChoices.addEventListener("change", () => { state.splitIds = new Set(queryAll("#splitChoices input:checked").map(input => input.value)); });
ui.expenseForm.addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const form = new FormData(event.target);
    if (!state.payerId) throw new Error("Select who paid");
    if (!state.splitIds.size) throw new Error("Select at least one split member");
    await api(`/api/trips/${state.trip.id}/expenses`, { method: "POST", body: JSON.stringify({ description: form.get("description"), amount: Number(form.get("amount")), paidBy: state.payerId, splitAmong: [...state.splitIds] }) });
    event.target.reset();
    await openTrip(state.trip.id);
  } catch (error) { showToast(error.message); }
});

// Member management
ui.peopleList.addEventListener("click", async event => {
  try {
    const settleRemoveId = event.target.dataset.settleRemove;
    const removeId = event.target.dataset.removeMember;
    if (settleRemoveId && confirm("Create the final settlement against the owner and remove this member?")) {
      await api(`/api/trips/${state.trip.id}/members/${settleRemoveId}/settle-remove`, { method: "POST", body: "{}" });
      showToast("Member settled and removed");
      await openTrip(state.trip.id);
    }
    if (removeId && confirm("Remove this fully settled member?")) {
      await api(`/api/trips/${state.trip.id}/members/${removeId}`, { method: "DELETE" });
      showToast("Member removed");
      await openTrip(state.trip.id);
    }
  } catch (error) { showToast(error.message); }
});

// Settlements
ui.settlementList.addEventListener("click", async event => {
  const value = event.target.dataset.markSettled;
  if (!value) return;
  const [from, to, amount] = value.split("|");
  if (!confirm(`Mark ${memberName(from)} paying ${memberName(to)} ${money(amount)} as settled?`)) return;
  try { await api(`/api/trips/${state.trip.id}/settlements`, { method: "POST", body: JSON.stringify({ from, to, amount: Number(amount) }) }); showToast("Settlement recorded"); await openTrip(state.trip.id); }
  catch (error) { showToast(error.message); }
});
ui.settlementHistory.addEventListener("click", async event => {
  const id = event.target.dataset.undoSettlement;
  if (!id || !confirm("Undo this settlement?")) return;
  try { await api(`/api/trips/${state.trip.id}/settlements/${id}`, { method: "DELETE" }); showToast("Settlement undone"); await openTrip(state.trip.id); }
  catch (error) { showToast(error.message); }
});

// Navigation and settings
byId("bottomNavigation").addEventListener("click", event => {
  const panelId = event.target.dataset.panel;
  if (!panelId) return;
  queryAll(".panel").forEach(panel => { panel.hidden = panel.id !== panelId; });
  queryAll("#bottomNavigation button").forEach(button => button.classList.toggle("active", button === event.target));
});
byId("leaveTripButton").addEventListener("click", async () => {
  if (!confirm("Leave this trip? Your balance must be zero.")) return;
  try { await api(`/api/trips/${state.trip.id}/leave`, { method: "POST", body: "{}" }); showToast("You left the trip"); await loadHome(); }
  catch (error) { showToast(error.message); }
});
byId("deleteTripButton").addEventListener("click", async () => {
  if (!confirm("Permanently delete this trip?")) return;
  try { await api(`/api/trips/${state.trip.id}`, { method: "DELETE" }); showToast("Trip deleted"); await loadHome(); }
  catch (error) { showToast(error.message); }
});

// Invite overlay: no browser dialog and no global ID variables
byId("inviteButton").addEventListener("click", openInviteOverlay);
byId("inviteCloseTopButton").addEventListener("click", closeInviteOverlay);
byId("inviteCloseButton").addEventListener("click", closeInviteOverlay);
ui.inviteOverlay.addEventListener("click", event => { if (event.target === ui.inviteOverlay) closeInviteOverlay(); });
document.addEventListener("keydown", event => { if (event.key === "Escape" && !ui.inviteOverlay.hidden) closeInviteOverlay(); });
byId("inviteCopyButton").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(ui.inviteLinkInput.value); showToast("Invite link copied"); }
  catch { ui.inviteLinkInput.select(); document.execCommand("copy"); showToast("Invite link copied"); }
});
byId("inviteShareButton").addEventListener("click", async () => {
  const url = getInviteUrl();
  try {
    if (navigator.share) await navigator.share({ title: "Join my TripSynch trip", text: `Join ${state.trip.name}`, url });
    else { await navigator.clipboard.writeText(url); showToast("Invite link copied"); }
  } catch (error) { if (error?.name !== "AbortError") showToast("Unable to share invite"); }
});

// Remove legacy V5/V6/V7 service workers and caches so old UI cannot be served.
(async () => {
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map(registration => registration.unregister()));
  }
  if ("caches" in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map(key => caches.delete(key)));
  }
})();

initialize();
