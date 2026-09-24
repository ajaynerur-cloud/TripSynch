const API = (window.TRIPSYNCH_CONFIG?.API_BASE || "").replace(/\/$/, "");
const $ = selector => document.querySelector(selector);

const S = {
  id: localStorage.tripId || "",
  mid: localStorage.memberId || "",
  secret: localStorage.tripSecret || "",
  t: null,
  timer: null
};

const esc = value =>
  String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);

const msg = message => {
  const toastElement = $("#toast");
  if (!toastElement) return;
  toastElement.textContent = message;
  toastElement.className = "show";
  setTimeout(() => {
    toastElement.className = "";
  }, 2200);
};

async function api(path, options = {}) {
  const response = await fetch(API + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-trip-secret": S.secret,
      ...options.headers
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Request failed ${response.status}`);
  }

  return data;
}

function save(data) {
  S.id = data.trip.id;
  S.mid = data.memberId;
  S.secret = data.secret;

  localStorage.tripId = S.id;
  localStorage.memberId = S.mid;
  localStorage.tripSecret = S.secret;
}

const name = id =>
  S.t?.members?.find(member => member.id === id)?.name || "Unknown";

const money = value =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: S.t?.currency || "INR"
  }).format(Number(value || 0));

function splitExpense(expense) {
  const participants = Array.isArray(expense.splitAmong)
    ? expense.splitAmong
    : [];

  if (!participants.length) return [];

  const amountInCents = Math.round(Number(expense.amount || 0) * 100);
  const baseShareInCents = Math.floor(amountInCents / participants.length);
  let remainderInCents = amountInCents - baseShareInCents * participants.length;

  return participants.map(memberId => {
    const extraCent = remainderInCents > 0 ? 1 : 0;
    remainderInCents -= extraCent;

    return {
      memberId,
      amount: (baseShareInCents + extraCent) / 100
    };
  });
}

function model() {
  const people = Object.fromEntries(
    S.t.members.map(member => [member.id, {
      ...member,
      paid: 0,
      share: 0,
      paidCount: 0,
      coveredForOthers: 0,
      coveredByOthers: 0,
      items: []
    }])
  );

  for (const expense of S.t.expenses) {
    if (!people[expense.paidBy]) continue;

    const shares = splitExpense(expense);
    const payerOwnShare = shares.find(
      item => item.memberId === expense.paidBy
    )?.amount || 0;

    people[expense.paidBy].paid += Number(expense.amount || 0);
    people[expense.paidBy].paidCount += 1;
    people[expense.paidBy].coveredForOthers +=
      Number(expense.amount || 0) - payerOwnShare;

    for (const share of shares) {
      if (!people[share.memberId]) continue;

      people[share.memberId].share += share.amount;
      people[share.memberId].items.push({
        expense,
        share: share.amount,
        payerOwnShare
      });

      if (share.memberId !== expense.paidBy) {
        people[share.memberId].coveredByOthers += share.amount;
      }
    }
  }

  Object.values(people).forEach(person => {
    person.paid = Number(person.paid.toFixed(2));
    person.share = Number(person.share.toFixed(2));
    person.coveredForOthers = Number(person.coveredForOthers.toFixed(2));
    person.coveredByOthers = Number(person.coveredByOthers.toFixed(2));
    person.balance = Number((person.paid - person.share).toFixed(2));
  });

  return people;
}

function plans(people) {
  const debtors = Object.values(people)
    .filter(person => person.balance < -0.005)
    .map(person => ({ id: person.id, value: -person.balance }));

  const creditors = Object.values(people)
    .filter(person => person.balance > 0.005)
    .map(person => ({ id: person.id, value: person.balance }));

  const result = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (
    debtorIndex < debtors.length &&
    creditorIndex < creditors.length
  ) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const beforeDebt = debtor.value;
    const beforeCredit = creditor.value;
    const amount = Math.min(beforeDebt, beforeCredit);

    result.push({
      from: debtor.id,
      to: creditor.id,
      amount: Number(amount.toFixed(2)),
      beforeDebt: Number(beforeDebt.toFixed(2)),
      beforeCredit: Number(beforeCredit.toFixed(2)),
      afterDebt: Number(Math.max(0, beforeDebt - amount).toFixed(2)),
      afterCredit: Number(Math.max(0, beforeCredit - amount).toFixed(2))
    });

    debtor.value -= amount;
    creditor.value -= amount;

    if (debtor.value < 0.005) debtorIndex += 1;
    if (creditor.value < 0.005) creditorIndex += 1;
  }

  return result;
}

function directObligationsForExpense(expense) {
  return splitExpense(expense)
    .filter(share => share.memberId !== expense.paidBy)
    .map(share => ({
      from: share.memberId,
      to: expense.paidBy,
      amount: share.amount
    }));
}

function contributingExpenses(person) {
  return person.items
    .filter(item => item.share > 0)
    .map(item => ({
      description: item.expense.description,
      payerId: item.expense.paidBy,
      share: item.share,
      paidByPerson: item.expense.paidBy === person.id
    }));
}

async function load() {
  if (!S.id) return;

  try {
    S.t = await api(`/api/trips/${S.id}`);
    render();
  } catch (error) {
    msg(error.message);
  }
}

function renderMyPosition(people, settlementPlan) {
  const container = $("#myPosition");
  if (!container) return;

  const me = people[S.mid];

  if (!me) {
    container.innerHTML = "";
    return;
  }

  const myPayments = settlementPlan.filter(
    payment => payment.from === S.mid || payment.to === S.mid
  );

  const paymentSummary = myPayments.length
    ? myPayments.map(payment => {
        if (payment.from === S.mid) {
          return `
            <div class="share">
              <span>You pay ${esc(name(payment.to))}</span>
              <b class="negative">${money(payment.amount)}</b>
            </div>`;
        }

        return `
          <div class="share">
            <span>${esc(name(payment.from))} pays you</span>
            <b class="positive">${money(payment.amount)}</b>
          </div>`;
      }).join("")
    : '<p class="muted">No payment is required for you.</p>';

  let statusText;
  if (me.balance > 0.005) {
    statusText = `You paid ${money(me.balance)} more than your allocated share. You should receive this amount from other members.`;
  } else if (me.balance < -0.005) {
    statusText = `Your allocated shares are ${money(-me.balance)} higher than the amount you paid. You need to pay this amount to other members.`;
  } else {
    statusText = "Your payments and allocated shares are balanced. You are fully settled.";
  }

  container.innerHTML = `
    <article class="card my-position-card">
      <div class="section-heading">
        <div>
          <p class="eyebrow">PERSONAL SUMMARY</p>
          <h2>My Position</h2>
        </div>
        <span class="status-pill ${
          me.balance > 0.005
            ? "status-receive"
            : me.balance < -0.005
              ? "status-pay"
              : "status-settled"
        }">
          ${
            me.balance > 0.005
              ? "You receive"
              : me.balance < -0.005
                ? "You pay"
                : "Settled"
          }
        </span>
      </div>

      <div class="moneygrid">
        <div class="metric">
          <span>Total paid</span>
          <b>${money(me.paid)}</b>
        </div>
        <div class="metric">
          <span>My allocated share</span>
          <b>${money(me.share)}</b>
        </div>
        <div class="metric">
          <span>Paid for others</span>
          <b>${money(me.coveredForOthers)}</b>
        </div>
        <div class="metric">
          <span>Covered by others</span>
          <b>${money(me.coveredByOthers)}</b>
        </div>
        <div class="metric metric-highlight">
          <span>Net balance</span>
          <b class="${me.balance >= 0 ? "positive" : "negative"}">
            ${me.balance > 0 ? "+" : ""}${money(me.balance)}
          </b>
        </div>
      </div>

      <div class="explain">
        <b>What this means</b>
        <p>${statusText}</p>
      </div>

      <div class="my-payments">
        <h3>My suggested payments</h3>
        ${paymentSummary}
      </div>
    </article>`;
}

function render() {
  const trip = S.t;
  const people = model();
  const settlementPlan = plans(people);
  const total = trip.expenses.reduce(
    (sum, expense) => sum + Number(expense.amount || 0),
    0
  );

  const welcome = $("#welcome");
  const tripView = $("#tripView");
  if (welcome) welcome.hidden = true;
  if (tripView) tripView.hidden = false;

  $("#tripName").textContent = trip.name;
  $("#sync").textContent =
    `Synced ${new Date().toLocaleTimeString()} · Code ${trip.code}`;

  $("#stats").innerHTML = `
    <div class="stat">
      <span>Total spent</span>
      <b>${money(total)}</b>
    </div>
    <div class="stat">
      <span>Members</span>
      <b>${trip.members.length}</b>
    </div>
    <div class="stat">
      <span>Expenses</span>
      <b>${trip.expenses.length}</b>
    </div>
    <div class="stat">
      <span>Payments needed</span>
      <b>${settlementPlan.length}</b>
    </div>`;

  renderMyPosition(people, settlementPlan);

  $("#paidBy").innerHTML = trip.members.map(member => `
    <option value="${member.id}" ${member.id === S.mid ? "selected" : ""}>
      ${esc(member.name)}
    </option>`).join("");

  $("#splitMembers").innerHTML = trip.members.map(member => `
    <label>
      <input type="checkbox" value="${member.id}" checked>
      ${esc(member.name)}
    </label>`).join("");

  $("#expenseList").innerHTML = trip.expenses.length
    ? trip.expenses.slice().reverse().map(expense => `
        <div class="row">
          <div>
            <b>${esc(expense.description)}</b>
            <span class="muted">
              Paid by ${esc(name(expense.paidBy))} ·
              ${expense.splitAmong.length} participants
            </span>
          </div>
          <b>${money(expense.amount)}</b>
        </div>`).join("")
    : '<p class="muted">No expenses yet.</p>';

  $("#personCards").innerHTML = Object.values(people).map(person => {
    let explanation;

    if (person.balance > 0.005) {
      explanation = `${esc(person.name)} paid ${money(person.balance)} more than their allocated shares and should receive this amount.`;
    } else if (person.balance < -0.005) {
      explanation = `${esc(person.name)} has ${money(-person.balance)} more in allocated shares than payments and therefore owes this amount.`;
    } else {
      explanation = `${esc(person.name)} is fully balanced.`;
    }

    const contributions = contributingExpenses(person);
    const itemList = contributions.length
      ? contributions.map(item => `
          <div class="share">
            <span>
              ${esc(item.description)}
              <small>
                ${
                  item.paidByPerson
                    ? "Paid by this person"
                    : `Paid by ${esc(name(item.payerId))}`
                }
              </small>
            </span>
            <b>${money(item.share)}</b>
          </div>`).join("")
      : '<p class="muted">No allocated expenses.</p>';

    return `
      <article class="card personcard">
        <div class="section-heading">
          <div>
            <h2>${esc(person.name)}</h2>
            <p class="muted">${person.paidCount} expense(s) paid</p>
          </div>
          <span class="status-pill ${
            person.balance > 0.005
              ? "status-receive"
              : person.balance < -0.005
                ? "status-pay"
                : "status-settled"
          }">
            ${
              person.balance > 0.005
                ? "Receives"
                : person.balance < -0.005
                  ? "Pays"
                  : "Settled"
            }
          </span>
        </div>

        <div class="moneygrid">
          <div class="metric">
            <span>Total paid</span>
            <b>${money(person.paid)}</b>
          </div>
          <div class="metric">
            <span>Personal share</span>
            <b>${money(person.share)}</b>
          </div>
          <div class="metric">
            <span>Paid for others</span>
            <b>${money(person.coveredForOthers)}</b>
          </div>
          <div class="metric">
            <span>Covered by others</span>
            <b>${money(person.coveredByOthers)}</b>
          </div>
          <div class="metric metric-highlight">
            <span>Net balance</span>
            <b class="${person.balance >= 0 ? "positive" : "negative"}">
              ${person.balance > 0 ? "+" : ""}${money(person.balance)}
            </b>
          </div>
        </div>

        <div class="explain">
          <b>Why this balance?</b>
          <p>${explanation}</p>
          <p class="formula">
            ${money(person.paid)} paid − ${money(person.share)} share =
            <b>${money(person.balance)}</b>
          </p>
        </div>

        <details>
          <summary>Show this person's expense shares</summary>
          <div class="shares">${itemList}</div>
        </details>
      </article>`;
  }).join("");

  $("#breakdownList").innerHTML = trip.expenses.length
    ? trip.expenses.map((expense, expenseIndex) => {
        const shares = splitExpense(expense);
        const directObligations = directObligationsForExpense(expense);
        const payerOwnShare = shares.find(
          share => share.memberId === expense.paidBy
        )?.amount || 0;
        const paidForOthers = Number(
          (Number(expense.amount) - payerOwnShare).toFixed(2)
        );

        const sharesHtml = shares.map(share => `
          <div class="share">
            <span>${esc(name(share.memberId))}'s allocated share</span>
            <b>${money(share.amount)}</b>
          </div>`).join("");

        const obligationsHtml = directObligations.length
          ? directObligations.map(obligation => `
              <div class="share obligation-row">
                <span>
                  ${esc(name(obligation.from))} benefited from an amount paid by
                  ${esc(name(obligation.to))}
                </span>
                <b>${money(obligation.amount)}</b>
              </div>`).join("")
          : '<p class="muted">The payer was the only participant, so no direct obligation was created.</p>';

        return `
          <article class="card expensecard">
            <div class="section-heading">
              <div>
                <p class="eyebrow">EXPENSE ${expenseIndex + 1}</p>
                <h2>${esc(expense.description)}</h2>
              </div>
              <b class="expense-total">${money(expense.amount)}</b>
            </div>

            <p>
              Paid by <b>${esc(name(expense.paidBy))}</b> for
              <b>${shares.length}</b> participant(s).
            </p>

            <div class="shares">
              <h3>How the amount was split</h3>
              ${sharesHtml}
            </div>

            <div class="explain">
              <b>What did the payer cover?</b>
              <p>
                ${esc(name(expense.paidBy))} paid ${money(expense.amount)}.
                ${
                  payerOwnShare > 0
                    ? `${money(payerOwnShare)} is ${esc(name(expense.paidBy))}'s own share.`
                    : `${esc(name(expense.paidBy))} was not included in the split.`
                }
                The amount covered for other members is
                <b>${money(paidForOthers)}</b>.
              </p>
            </div>

            <details>
              <summary>Show obligations created by this expense</summary>
              <div class="shares">${obligationsHtml}</div>
            </details>
          </article>`;
      }).join("")
    : '<article class="card">No expense breakdown yet.</article>';

  $("#settlementList").innerHTML = settlementPlan.length
    ? settlementPlan.map((payment, index) => {
        const payer = people[payment.from];
        const receiver = people[payment.to];

        const payerReasons = payer.items
          .filter(item => item.expense.paidBy !== payer.id)
          .map(item => `
            <div class="share">
              <span>
                ${esc(item.expense.description)} share,
                paid by ${esc(name(item.expense.paidBy))}
              </span>
              <b>${money(item.share)}</b>
            </div>`).join("");

        return `
          <article class="card payment">
            <div class="payment-title">
              <span class="payment-number">${index + 1}</span>
              <div>
                <h2>
                  ${esc(name(payment.from))} pays
                  ${esc(name(payment.to))}
                </h2>
                <strong class="payment-amount">${money(payment.amount)}</strong>
              </div>
            </div>

            <div class="explain">
              <b>How was this calculated?</b>
              <p>
                ${esc(name(payment.from))} owes
                <b>${money(payment.beforeDebt)}</b> because that person's total
                allocated shares exceed that person's payments.
              </p>
              <p>
                ${esc(name(payment.to))} should receive
                <b>${money(payment.beforeCredit)}</b> because that person paid
                more than that person's own allocated shares.
              </p>
              <p>
                TripSynch settles the smaller outstanding balance first.
                Therefore, the suggested payment is
                <b>${money(payment.amount)}</b>.
              </p>
            </div>

            <div class="moneygrid">
              <div class="metric">
                <span>${esc(name(payment.from))} owed before</span>
                <b>${money(payment.beforeDebt)}</b>
              </div>
              <div class="metric">
                <span>${esc(name(payment.from))} owes after</span>
                <b>${money(payment.afterDebt)}</b>
              </div>
              <div class="metric">
                <span>${esc(name(payment.to))} due before</span>
                <b>${money(payment.beforeCredit)}</b>
              </div>
              <div class="metric">
                <span>${esc(name(payment.to))} due after</span>
                <b>${money(payment.afterCredit)}</b>
              </div>
            </div>

            <details>
              <summary>Show expenses contributing to this person's debt</summary>
              <div class="shares">
                ${payerReasons || '<p class="muted">No direct expense items available.</p>'}
              </div>
            </details>
          </article>`;
      }).join("")
    : '<article class="card"><h2>Everyone is settled</h2><p>No payment is required.</p></article>';

  const endTripButton = $("#endTrip");
  if (endTripButton) {
    endTripButton.disabled = S.mid !== trip.ownerId;
  }
}

const createForm = $("#createForm");
if (createForm) {
  createForm.addEventListener("submit", async event => {
    event.preventDefault();

    try {
      const data = await api("/api/trips", {
        method: "POST",
        body: JSON.stringify(
          Object.fromEntries(new FormData(event.target))
        )
      });

      save(data);
      await load();
      poll();
    } catch (error) {
      msg(error.message);
    }
  });
}

const joinForm = $("#joinForm");
if (joinForm) {
  joinForm.addEventListener("submit", async event => {
    event.preventDefault();

    try {
      const data = await api("/api/join", {
        method: "POST",
        body: JSON.stringify(
          Object.fromEntries(new FormData(event.target))
        )
      });

      save(data);
      await load();
      poll();
    } catch (error) {
      msg(error.message);
    }
  });
}

const expenseForm = $("#expenseForm");
if (expenseForm) {
  expenseForm.addEventListener("submit", async event => {
    event.preventDefault();

    try {
      const form = new FormData(event.target);
      const splitAmong = [
        ...$("#splitMembers").querySelectorAll(":checked")
      ].map(input => input.value);

      if (!splitAmong.length) {
        throw new Error("Select at least one member for the split.");
      }

      await api(`/api/trips/${S.id}/expenses`, {
        method: "POST",
        body: JSON.stringify({
          description: form.get("description"),
          amount: Number(form.get("amount")),
          paidBy: form.get("paidBy"),
          splitAmong,
          actorId: S.mid
        })
      });

      event.target.reset();
      await load();
    } catch (error) {
      msg(error.message);
    }
  });
}

const navigation = document.querySelector("nav");
if (navigation) {
  navigation.addEventListener("click", event => {
    const tabName = event.target.dataset.tab;
    if (!tabName) return;

    document.querySelectorAll("nav button").forEach(button => {
      button.classList.toggle("active", button === event.target);
    });

    document.querySelectorAll(".panel").forEach(panel => {
      panel.hidden = true;
    });

    const targetPanel = $("#" + tabName);
    if (targetPanel) targetPanel.hidden = false;
  });
}

const inviteButton = $("#invite");
if (inviteButton) {
  inviteButton.addEventListener("click", () => {
    const inviteUrl =
      `${location.origin}${location.pathname}?join=${S.t.code}`;

    $("#inviteLink").value = inviteUrl;
    $("#qr").src =
      `${API}/api/qr?text=${encodeURIComponent(inviteUrl)}`;
    $("#inviteDialog").showModal();
  });
}

const closeInviteButton = $("#closeInvite");
if (closeInviteButton) {
  closeInviteButton.addEventListener("click", () => {
    $("#inviteDialog").close();
  });
}

const copyInviteButton = $("#copyInvite");
if (copyInviteButton) {
  copyInviteButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#inviteLink").value);
    msg("Invite copied");
  });
}

const leaveButton = $("#leave");
if (leaveButton) {
  leaveButton.addEventListener("click", () => {
    localStorage.removeItem("tripId");
    localStorage.removeItem("memberId");
    localStorage.removeItem("tripSecret");
    location.href = location.pathname;
  });
}

const endTripButton = $("#endTrip");
if (endTripButton) {
  endTripButton.addEventListener("click", async () => {
    if (!confirm("Delete this trip and its current data?")) return;

    try {
      await api(`/api/trips/${S.id}`, {
        method: "DELETE",
        body: JSON.stringify({ actorId: S.mid })
      });

      leaveButton?.click();
    } catch (error) {
      msg(error.message);
    }
  });
}

function poll() {
  clearInterval(S.timer);
  S.timer = setInterval(load, 4000);
}

const joinCode = new URLSearchParams(location.search).get("join");
if (joinCode) {
  const joinCodeInput = document.querySelector(
    '#joinForm [name="code"]'
  );
  if (joinCodeInput) joinCodeInput.value = joinCode.toUpperCase();
}

if (S.id) {
  load();
  poll();
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js");
}
