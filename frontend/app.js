const CONFIG = window.TRIPSYNCH_CONFIG;
const $ = selector => document.querySelector(selector);

const state = {
  tripId: localStorage.tid || "",
  memberId: localStorage.mid || "",
  token: localStorage.tripToken || "",
  trip: null,
  payerId: "",
  timer: null
};

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
})[character]);

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = "on";
  window.setTimeout(() => {
    toast.className = "";
  }, 2200);
}

async function api(path, options = {}) {
  const response = await fetch(CONFIG.API_BASE.replace(/\/$/, "") + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-trip-secret": state.token,
      ...options.headers
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

function saveSession(data) {
  state.tripId = data.trip.id;
  state.memberId = data.memberId;
  state.token = data.token;
  localStorage.tid = state.tripId;
  localStorage.mid = state.memberId;
  localStorage.tripToken = state.token;
}

function clearSession() {
  ["tid", "mid", "tripToken"].forEach(key => localStorage.removeItem(key));
  window.location.href = "/";
}

const memberName = id =>
  state.trip?.members?.find(member => member.id === id)?.name || "Unknown";

const money = value => new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: state.trip?.currency || "INR"
}).format(Number(value || 0));

const formatDate = value =>
  value ? new Date(value).toLocaleString() : "Date unavailable";

const toCents = value => Math.round(Number(value || 0) * 100);

function buildBalanceModel() {
  const balances = Object.fromEntries(
    state.trip.members.map(member => [member.id, {
      ...member,
      paid: 0,
      share: 0,
      expenseCount: 0,
      balance: 0
    }])
  );

  for (const expense of state.trip.expenses) {
    const participants = expense.splitAmong || [];
    if (!participants.length || !balances[expense.paidBy]) continue;

    const total = toCents(expense.amount);
    const baseShare = Math.floor(total / participants.length);
    let remainder = total - baseShare * participants.length;

    balances[expense.paidBy].paid += total;
    balances[expense.paidBy].expenseCount += 1;

    participants.forEach(memberId => {
      if (!balances[memberId]) return;
      const extraCent = remainder > 0 ? 1 : 0;
      remainder -= extraCent;
      balances[memberId].share += baseShare + extraCent;
    });
  }

  for (const settlement of state.trip.settlements || []) {
    if (settlement.status !== "settled") continue;
    const amount = toCents(settlement.amount);
    if (balances[settlement.from]) balances[settlement.from].paid += amount;
    if (balances[settlement.to]) balances[settlement.to].paid -= amount;
  }

  Object.values(balances).forEach(person => {
    person.balance = person.paid - person.share;
  });

  return balances;
}

function buildSettlementPlan(balances) {
  const debtors = Object.values(balances)
    .filter(person => person.balance < 0)
    .map(person => ({ id: person.id, value: -person.balance }));

  const creditors = Object.values(balances)
    .filter(person => person.balance > 0)
    .map(person => ({ id: person.id, value: person.balance }));

  const plan = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amount = Math.min(debtor.value, creditor.value);

    plan.push({
      from: debtor.id,
      to: creditor.id,
      amount: amount / 100,
      beforeDebt: debtor.value / 100,
      beforeCredit: creditor.value / 100
    });

    debtor.value -= amount;
    creditor.value -= amount;
    if (debtor.value < 1) debtorIndex += 1;
    if (creditor.value < 1) creditorIndex += 1;
  }

  return plan;
}

function expenseShares(expense) {
  const participants = expense.splitAmong || [];
  if (!participants.length) return [];

  const total = toCents(expense.amount);
  const baseShare = Math.floor(total / participants.length);
  let remainder = total - baseShare * participants.length;

  return participants.map(memberId => {
    const extraCent = remainder > 0 ? 1 : 0;
    remainder -= extraCent;
    return { memberId, amount: (baseShare + extraCent) / 100 };
  });
}

async function loadTrip() {
  if (!state.tripId) return;
  try {
    state.trip = await api(`/api/trips/${state.tripId}`);
    render();
  } catch (error) {
    showToast(error.message);
  }
}

function render() {
  $("#welcome").hidden = true;
  $("#app").hidden = false;
  $("#title").textContent = state.trip.name;
  $("#sync").textContent =
    `Code ${state.trip.code} · ${new Date().toLocaleTimeString()}`;

  const balances = buildBalanceModel();
  const plan = buildSettlementPlan(balances);
  const me = balances[state.memberId];
  const total = state.trip.expenses.reduce(
    (sum, expense) => sum + Number(expense.amount || 0),
    0
  );

  $("#stats").innerHTML = `
    <div class="stat">Total<b>${money(total)}</b></div>
    <div class="stat">Members<b>${state.trip.members.length}</b></div>
    <div class="stat">Expenses<b>${state.trip.expenses.length}</b></div>
    <div class="stat">Open settlements<b>${plan.length}</b></div>`;

  $("#mine").innerHTML = me ? `
    <article>
      <h2>My position</h2>
      <div class="metrics">
        <div class="metric">Paid<b>${money(me.paid / 100)}</b></div>
        <div class="metric">Share<b>${money(me.share / 100)}</b></div>
        <div class="metric">Balance<b class="${me.balance >= 0 ? "positive" : "negative"}">${money(me.balance / 100)}</b></div>
        <div class="metric">Status<b>${me.balance > 0 ? "Receive" : me.balance < 0 ? "Pay" : "Settled"}</b></div>
      </div>
    </article>` : "";

  const selectedPayer =
    document.querySelector('input[name="paidBy"]:checked')?.value ||
    state.payerId ||
    state.memberId;
  state.payerId = selectedPayer;

  $("#payers").innerHTML = state.trip.members.map(member => `
    <label class="choice ${member.id === selectedPayer ? "selected" : ""}">
      <input type="radio" name="paidBy" value="${member.id}" ${member.id === selectedPayer ? "checked" : ""}>
      ${escapeHtml(member.name)}
    </label>`).join("");

  $("#splits").innerHTML = state.trip.members.map(member => `
    <label class="choice">
      <input type="checkbox" value="${member.id}" checked>
      ${escapeHtml(member.name)}
    </label>`).join("");

  $("#expenseList").innerHTML = state.trip.expenses.length
    ? state.trip.expenses.slice().reverse().map(expense => `
        <div class="row">
          <span>
            <b>${escapeHtml(expense.description)}</b>
            <small>Paid by ${escapeHtml(memberName(expense.paidBy))}</small>
            <span class="date">Created ${formatDate(expense.createdAt)}</span>
          </span>
          <b>${money(expense.amount)}</b>
        </div>`).join("")
    : "<p>No expenses yet.</p>";

  $("#peopleList").innerHTML = Object.values(balances).map(person => `
    <article>
      <h2>${escapeHtml(person.name)}</h2>
      <div class="metrics">
        <div class="metric">Paid<b>${money(person.paid / 100)}</b></div>
        <div class="metric">Share<b>${money(person.share / 100)}</b></div>
        <div class="metric">Expenses paid<b>${person.expenseCount}</b></div>
        <div class="metric">Balance<b>${money(person.balance / 100)}</b></div>
      </div>
      <div class="why">
        ${person.balance > 0
          ? `Receives ${money(person.balance / 100)} because payments exceed allocated shares.`
          : person.balance < 0
            ? `Pays ${money(-person.balance / 100)} because allocated shares exceed payments.`
            : "Fully settled."}
      </div>
    </article>`).join("");

  $("#detailList").innerHTML = state.trip.expenses.length
    ? state.trip.expenses.map((expense, index) => {
        const shares = expenseShares(expense);
        const obligations = shares
          .filter(share => share.memberId !== expense.paidBy)
          .map(share =>
            `${escapeHtml(memberName(share.memberId))} owes ${escapeHtml(memberName(expense.paidBy))} ${money(share.amount)}`
          ).join("; ");

        return `
          <article>
            <small>EXPENSE ${index + 1}</small>
            <h2>${escapeHtml(expense.description)}</h2>
            <b>${money(expense.amount)} paid by ${escapeHtml(memberName(expense.paidBy))}</b>
            <p class="date">Created ${formatDate(expense.createdAt)}</p>
            ${shares.map(share => `
              <div class="share">
                <span>${escapeHtml(memberName(share.memberId))}'s share</span>
                <b>${money(share.amount)}</b>
              </div>`).join("")}
            <div class="why">${obligations || "No other member owes for this expense."}</div>
          </article>`;
      }).join("")
    : "<article>No details yet.</article>";

  $("#settleList").innerHTML = plan.length
    ? plan.map(item => `
        <div class="payment">
          <b>${escapeHtml(memberName(item.from))} pays ${escapeHtml(memberName(item.to))} ${money(item.amount)}</b>
          <div class="why">
            ${escapeHtml(memberName(item.from))} owes ${money(item.beforeDebt)} and
            ${escapeHtml(memberName(item.to))} should receive ${money(item.beforeCredit)}.
            The smaller outstanding balance is suggested.
          </div>
          <button type="button" data-settle="${item.from}|${item.to}|${item.amount}">Mark settled</button>
        </div>`).join("")
    : '<div class="settled">Everyone is settled.</div>';

  $("#history").innerHTML = (state.trip.settlements || []).length
    ? state.trip.settlements.slice().reverse().map(item => `
        <div class="settled">
          <b>${escapeHtml(memberName(item.from))} paid ${escapeHtml(memberName(item.to))} ${money(item.amount)}</b>
          <small>${formatDate(item.settledAt)}</small>
          <button type="button" data-undo="${item.id}" class="secondary">Undo</button>
        </div>`).join("")
    : "<p>No completed settlements.</p>";

  $("#end").disabled = state.memberId !== state.trip.ownerId;
}

document.addEventListener("change", event => {
  if (event.target.name === "paidBy") {
    state.payerId = event.target.value;
    $("#payers").querySelectorAll(".choice").forEach(label => {
      label.classList.toggle("selected", label.contains(event.target));
    });
  }
});

$("#createForm").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const data = await api("/api/trips", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(event.target)))
    });
    saveSession(data);
    await loadTrip();
    startPolling();
  } catch (error) {
    showToast(error.message);
  }
});

$("#joinForm").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const data = await api("/api/join", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(event.target)))
    });
    saveSession(data);
    await loadTrip();
    startPolling();
  } catch (error) {
    showToast(error.message);
  }
});

$("#expenseForm").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const form = new FormData(event.target);
    const splitAmong = [...$("#splits").querySelectorAll(":checked")]
      .map(input => input.value);

    if (!state.payerId) throw new Error("Select who paid.");
    if (!splitAmong.length) throw new Error("Select at least one split member.");

    await api(`/api/trips/${state.tripId}/expenses`, {
      method: "POST",
      body: JSON.stringify({
        description: form.get("description"),
        amount: Number(form.get("amount")),
        paidBy: state.payerId,
        splitAmong,
        actorId: state.memberId
      })
    });

    event.target.reset();
    await loadTrip();
  } catch (error) {
    showToast(error.message);
  }
});

$("#settleList").addEventListener("click", async event => {
  const value = event.target.dataset.settle;
  if (!value) return;

  const [from, to, amount] = value.split("|");
  if (!confirm(`Mark ${memberName(from)} paying ${memberName(to)} ${money(amount)} as settled?`)) return;

  try {
    await api(`/api/trips/${state.tripId}/settlements`, {
      method: "POST",
      body: JSON.stringify({
        from,
        to,
        amount: Number(amount),
        actorId: state.memberId
      })
    });
    showToast("Settlement recorded");
    await loadTrip();
  } catch (error) {
    showToast(error.message);
  }
});

$("#history").addEventListener("click", async event => {
  const settlementId = event.target.dataset.undo;
  if (!settlementId || !confirm("Undo this settlement?")) return;

  try {
    await api(`/api/trips/${state.tripId}/settlements/${settlementId}`, {
      method: "DELETE"
    });
    showToast("Settlement undone");
    await loadTrip();
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelectorAll("[data-mode]").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-mode]").forEach(item => {
      item.classList.toggle("active", item === button);
    });
    $("#createForm").hidden = button.dataset.mode !== "create";
    $("#joinForm").hidden = button.dataset.mode !== "join";
  });
});

$("nav").addEventListener("click", event => {
  const tab = event.target.dataset.tab;
  if (!tab) return;

  document.querySelectorAll(".panel").forEach(panel => {
    panel.hidden = true;
  });
  $("#" + tab).hidden = false;
  document.querySelectorAll("nav button").forEach(button => {
    button.classList.toggle("active", button === event.target);
  });
});

const inviteDialog = $("#inviteDialog");
const inviteLink = $("#inviteLink");
const inviteQr = $("#inviteQr");
const closeButtons = [$("#closeInviteDialog"), $("#closeInviteDialogTop")];

function getInviteUrl() {
  return `${CONFIG.APP_URL.replace(/\/$/, "")}?join=${encodeURIComponent(state.trip.code)}`;
}

function openInviteDialog() {
  inviteLink.value = getInviteUrl();
  inviteQr.src = `${CONFIG.API_BASE.replace(/\/$/, "")}/api/qr?text=${encodeURIComponent(inviteLink.value)}`;
  document.body.classList.add("dialog-open");

  if (typeof inviteDialog.showModal === "function") {
    inviteDialog.showModal();
  } else {
    inviteDialog.setAttribute("open", "");
  }
}

function closeInviteDialog() {
  if (typeof inviteDialog.close === "function" && inviteDialog.open) {
    inviteDialog.close();
  } else {
    inviteDialog.removeAttribute("open");
  }
  document.body.classList.remove("dialog-open");
}

$("#invite").addEventListener("click", openInviteDialog);

closeButtons.forEach(button => {
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    closeInviteDialog();
  });
});

inviteDialog.addEventListener("cancel", event => {
  event.preventDefault();
  closeInviteDialog();
});

inviteDialog.addEventListener("click", event => {
  if (event.target === inviteDialog) closeInviteDialog();
});

$("#shareInvite").addEventListener("click", async () => {
  const url = getInviteUrl();
  try {
    if (navigator.share) {
      await navigator.share({
        title: "Join my TripSynch trip",
        text: `Join ${state.trip.name}`,
        url
      });
    } else {
      await navigator.clipboard.writeText(url);
      showToast("Invite link copied");
    }
  } catch (error) {
    if (error?.name !== "AbortError") showToast("Unable to share invite");
  }
});

$("#copyInvite").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(inviteLink.value);
    showToast("Invite link copied");
  } catch {
    inviteLink.select();
    document.execCommand("copy");
    showToast("Invite link copied");
  }
});

$("#leave").addEventListener("click", clearSession);

$("#end").addEventListener("click", async () => {
  if (!confirm("Delete this trip?")) return;
  try {
    await api(`/api/trips/${state.tripId}`, {
      method: "DELETE",
      body: JSON.stringify({ actorId: state.memberId })
    });
    clearSession();
  } catch (error) {
    showToast(error.message);
  }
});

function startPolling() {
  clearInterval(state.timer);
  state.timer = setInterval(loadTrip, 4000);
}

const joinCode = new URLSearchParams(window.location.search).get("join");
if (joinCode) {
  document.querySelector('[data-mode="join"]').click();
  document.querySelector('#joinForm [name="code"]').value = joinCode.toUpperCase();
}

if (state.tripId) {
  loadTrip();
  startPolling();
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}
