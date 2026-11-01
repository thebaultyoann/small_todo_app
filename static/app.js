"use strict";

const projectsEl = document.getElementById("projects");
const emptyEl = document.getElementById("empty");
const dashboardEl = document.getElementById("dashboard");
const newProjectSlot = document.getElementById("new-project-slot");
const toastEl = document.getElementById("toast");

const DEFAULT_TIME = "18:00";
// Palette des projets (les teintes sont définies dans le CSS : --c-<clé>).
const COLORS = [["red", "Rouge"], ["orange", "Orange"], ["yellow", "Jaune"], ["green", "Vert"], ["teal", "Turquoise"], ["blue", "Bleu"], ["purple", "Violet"], ["pink", "Rose"], ["gray", "Gris"]];
const MIN_WIDTH = 220;

// Projet dans lequel le formulaire « nouvelle tâche » est ouvert.
let addingTaskIn = null;
// Projets dont le groupe « Terminées » est déplié.
const openDone = new Set();
let toastTimer = null;

/* ---------- Utilitaires ---------- */

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value == null) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "value" || key === "checked") el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return el;
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 4000);
}

async function api(method, url, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.text()).trim() || res.statusText);
    return res.status === 204 ? null : await res.json();
  } catch (err) {
    toast("Erreur : " + err.message);
    throw err;
  }
}

const pad = (n) => String(n).padStart(2, "0");

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const dayFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const dayYearFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const shortFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short" });
const shortYearFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

// "2026-10-22T15:30" -> "jeudi 22 octobre 15h30" (full), "jeu. 22 oct. 15h30" (short) ou "15h30" (time)
function formatDue(value, mode = "full") {
  const d = new Date(value);
  if (isNaN(d)) return value;
  const time = `${pad(d.getHours())}h${pad(d.getMinutes())}`;
  if (mode === "time") return time;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const fmt = mode === "short" ? (sameYear ? shortFmt : shortYearFmt) : sameYear ? dayFmt : dayYearFmt;
  return `${fmt.format(d)} ${time}`;
}

// "2026-10-31" + n jours -> "2026-11-01"
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

// En retard = la date est passée (on compare les jours, pas l'heure).
function isLate(task) {
  return !task.done && !!task.due_at && task.due_at.slice(0, 10) < todayStr();
}

/* ---------- Chargement et rendu ---------- */

let lastProjects = [];
let currentTab = location.hash === "#dashboard" ? "dashboard" : "tasks";

async function load() {
  const projects = await api("GET", "/api/projects");
  render(projects);
}

function render(projects) {
  lastProjects = projects;
  if (currentTab === "dashboard") {
    renderDashboard(projects);
    return;
  }

  projectsEl.replaceChildren(...projects.map(renderProject));
  emptyEl.hidden = projects.length > 0;

  if (addingTaskIn !== null) {
    const input = projectsEl.querySelector(`.project[data-id="${addingTaskIn}"] .add-task input[type="text"]`);
    if (input) input.focus();
    else addingTaskIn = null;
  }
}

/* ---------- Onglets ---------- */

function applyTab() {
  const dash = currentTab === "dashboard";
  document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === currentTab)));
  projectsEl.hidden = dash;
  dashboardEl.hidden = !dash;
  newProjectSlot.hidden = dash;
  if (dash) emptyEl.hidden = true;
}

function setTab(tab) {
  if (tab === currentTab) return;
  currentTab = tab;
  history.replaceState(null, "", "#" + tab);
  applyTab();
  load();
}

document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

/* ---------- Dashboard ---------- */

// Cartes et projets repliés dans le dashboard : simple préférence d'affichage,
// conservée dans le navigateur.
const DASH_KEY = "todolist.dashClosed";
const dashClosed = (() => {
  try { return new Set(JSON.parse(localStorage.getItem(DASH_KEY) || "[]")); } catch { return new Set(); }
})();

function toggleDashClosed(key) {
  if (dashClosed.has(key)) dashClosed.delete(key);
  else dashClosed.add(key);
  try { localStorage.setItem(DASH_KEY, JSON.stringify([...dashClosed])); } catch {}
  renderDashboard(lastProjects);
}

// Fenêtres glissantes : la semaine = aujourd'hui + 6 jours, le mois = aujourd'hui + 30 jours.
// « Dans le mois » inclut tout le reste, y compris les retards.
function renderDashboard(projects) {
  const today = todayStr();
  const tomorrow = addDays(today, 1);
  const weekEnd = addDays(today, 6);
  const monthEnd = addDays(today, 30);

  const sections = [
    { id: "today", title: "À faire aujourd’hui", dateMode: "time", empty: "Rien de prévu aujourd’hui.", test: (d) => d === today },
    { id: "tomorrow", title: "À faire demain", dateMode: "time", empty: "Rien de prévu demain.", test: (d) => d === tomorrow },
    { id: "week", title: "À faire cette semaine", hint: "7 prochains jours", dateMode: "short", empty: "Rien de prévu cette semaine.", test: (d) => d >= today && d <= weekEnd },
    { id: "late", title: "Tâches en retard", late: true, dateMode: "short", empty: "Aucune tâche en retard.", test: (d) => d < today },
    { id: "month", title: "À faire dans le mois", hint: "30 prochains jours, retards inclus", dateMode: "short", empty: "Rien de prévu dans le mois.", test: (d) => d <= monthEnd },
  ];

  dashboardEl.replaceChildren(...sections.map((s) => renderDashSection(s, projects)));
}

function renderDashSection(def, projects) {
  // Tâches à faire et datées uniquement, regroupées par projet.
  const groups = [];
  let total = 0;
  for (const project of projects) {
    const tasks = project.tasks
      .filter((t) => !t.done && t.due_at && def.test(t.due_at.slice(0, 10)))
      .sort((a, b) => a.due_at.localeCompare(b.due_at));
    if (tasks.length) {
      groups.push({ project, tasks });
      total += tasks.length;
    }
  }

  // Ici : renommer, cocher et changer une date existante, mais ni ajout, ni retrait de date, ni suppression.
  const opts = { dateMode: def.dateMode, allowClear: false, allowAddDate: false, deletable: false };

  const cardKey = `card:${def.id}`;
  const cardClosed = dashClosed.has(cardKey);

  const header = h(
    "header",
    { class: "dash-head" },
    h(
      "h2",
      {},
      h(
        "button",
        {
          class: "dash-toggle",
          "aria-expanded": String(!cardClosed),
          title: cardClosed ? "Ouvrir" : "Fermer",
          onclick: () => toggleDashClosed(cardKey),
        },
        h("span", { class: "chev", "aria-hidden": "true" }, "›"),
        def.title
      )
    ),
    h("span", { class: "count" }, String(total)),
    !cardClosed && def.hint ? h("span", { class: "hint" }, def.hint) : null
  );

  let body = null;
  if (!cardClosed) {
    body =
      total === 0
        ? h("p", { class: "dash-empty" }, def.empty)
        : groups.map((g) => {
            const groupKey = `group:${def.id}:${g.project.id}`;
            const groupClosed = dashClosed.has(groupKey);
            return h(
              "div",
              { class: "dash-group" },
              h(
                "h3",
                { class: "dash-project" },
                h(
                  "button",
                  {
                    class: "dash-toggle",
                    "aria-expanded": String(!groupClosed),
                    title: groupClosed ? "Ouvrir" : "Fermer",
                    onclick: () => toggleDashClosed(groupKey),
                  },
                  h("span", { class: "chev", "aria-hidden": "true" }, "›"),
                  g.project.color ? h("span", { class: "dot", "data-color": g.project.color }) : null,
                  g.project.name,
                  groupClosed ? h("span", { class: "group-count" }, String(g.tasks.length)) : null
                )
              ),
              groupClosed ? null : h("ul", { class: "tasks" }, g.tasks.map((t) => renderTask(t, opts)))
            );
          });
  }

  return h("section", { class: "dash-card" + (def.late ? " late" : "") + (cardClosed ? " closed" : "") }, header, body);
}

function renderProject(project) {
  const active = project.tasks.filter((t) => !t.done);
  const done = project.tasks.filter((t) => t.done);

  const card = h("section", {
    class: "project" + (project.own_row ? " own-row" : "") + (project.collapsed ? " collapsed" : ""),
    "data-id": project.id,
    "data-color": project.color || null,
  });
  card.style.setProperty("--w", (project.width || 380) + "px");

  // Poignée : le glisser-déposer n'est activé que depuis elle,
  // pour ne pas gêner la sélection de texte dans les champs.
  const grip = h("span", { class: "grip", title: "Glisser pour déplacer le projet", "aria-hidden": "true" }, "⋮");
  grip.addEventListener("mousedown", () => (card.draggable = true));

  const chevron = h(
    "button",
    {
      class: "chev-btn",
      "aria-expanded": String(!project.collapsed),
      "aria-label": project.collapsed ? "Ouvrir le projet" : "Fermer le projet",
      onclick: async () => {
        try { await api("PATCH", `/api/projects/${project.id}`, { collapsed: !project.collapsed }); } catch {}
        load();
      },
    },
    h("span", { class: "chev", "aria-hidden": "true" }, "›")
  );

  const name = h("h2", { class: "project-name", title: "Cliquer pour renommer" }, project.name);
  name.addEventListener("click", () => editProjectName(name, project));

  card.append(
    h(
      "div",
      { class: "project-head" },
      grip,
      chevron,
      name,
      project.collapsed && active.length ? h("span", { class: "count", title: "Tâches à faire" }, String(active.length)) : null,
      h("span", { class: "head-spacer" }),
      renderMenu(name, project)
    )
  );

  if (!project.collapsed) {
    // Attention : append(null) écrirait littéralement "null" ; on écarte les blocs absents.
    card.append(...[renderTaskList(active), renderDone(project, done), renderAddTask(project)].filter(Boolean));
  }
  card.append(renderResizeHandle(card, project));

  card.addEventListener("dragstart", (e) => {
    if (e.target !== card) return; // ignore les glissements venant des tâches
    draggedProject = card;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(project.id)); // requis par Firefox
    requestAnimationFrame(() => card.classList.add("dragging"));
  });
  card.addEventListener("dragend", onProjectDragEnd);

  return card;
}

/* ---------- Tâches ---------- */

function renderTaskList(active) {
  const ul = h("ul", { class: "tasks" }, active.map((t) => renderTask(t, { reorderable: true })));

  ul.addEventListener("dragover", (e) => {
    if (!draggedTask || draggedTask.parentElement !== ul) return; // réordonnancement dans le même projet
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    const over = e.target.closest(".task");
    if (!over || over === draggedTask) return;
    const r = over.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    if (after && over.nextElementSibling !== draggedTask) over.after(draggedTask);
    else if (!after && over.previousElementSibling !== draggedTask) over.before(draggedTask);
  });

  return ul;
}

function renderDone(project, done) {
  if (!done.length) return null;

  const details = h(
    "details",
    { class: "done-group" },
    h("summary", {}, h("span", { class: "chev", "aria-hidden": "true" }, "›"), `Terminées (${done.length})`),
    h("ul", { class: "tasks done-list" }, done.map((t) => renderTask(t)))
  );
  details.open = openDone.has(project.id);
  details.addEventListener("toggle", () => {
    if (details.open) openDone.add(project.id);
    else openDone.delete(project.id);
  });
  return details;
}

function renderTask(task, opts = {}) {
  const { reorderable = false, spacer = true, dateMode = "full", allowClear = true, allowAddDate = true, deletable = true } = opts;
  const li = h("li", { class: "task" + (task.done ? " is-done" : ""), "data-id": task.id });

  if (reorderable) {
    const grip = h("span", { class: "grip", title: "Glisser pour réordonner", "aria-hidden": "true" }, "⋮");
    grip.addEventListener("mousedown", () => (li.draggable = true));
    li.append(grip);

    li.addEventListener("dragstart", (e) => {
      if (e.target !== li) return;
      e.stopPropagation();
      draggedTask = li;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(task.id)); // requis par Firefox
      requestAnimationFrame(() => li.classList.add("dragging"));
    });
    li.addEventListener("dragend", onTaskDragEnd);
  } else if (spacer) {
    // Même largeur de colonne que la poignée, pour garder l'alignement.
    li.append(h("span", { class: "grip", "aria-hidden": "true" }));
  }

  const checkbox = h("input", {
    type: "checkbox",
    checked: task.done,
    "aria-label": "Terminée",
    onchange: async (e) => {
      try { await api("PATCH", `/api/tasks/${task.id}`, { done: e.target.checked }); } catch {}
      load();
    },
  });

  const title = h("span", { class: "task-title", title: "Cliquer pour modifier" }, task.title);
  title.addEventListener("click", () => editTaskTitle(title, task));

  li.append(checkbox, title);

  if (task.due_at) {
    const date = h(
      "button",
      { class: "task-date" + (isLate(task) ? " late" : ""), title: "Cliquer pour modifier la date" },
      formatDue(task.due_at, dateMode)
    );
    date.addEventListener("click", () => editTaskDate(date, task, { allowClear }));
    li.append(h("span", { class: "task-sep" }, "-"), date);
  } else if (allowAddDate) {
    const date = h("button", { class: "task-date empty-date" }, "ajouter une date");
    date.addEventListener("click", () => editTaskDate(date, task, { allowClear }));
    li.append(date);
  }

  if (deletable) {
    li.append(
      h(
        "button",
        {
          class: "task-del",
          title: "Supprimer la tâche",
          "aria-label": "Supprimer la tâche",
          onclick: async () => {
            try { await api("DELETE", `/api/tasks/${task.id}`); } catch {}
            load();
          },
        },
        "✕"
      )
    );
  }
  return li;
}

function editTaskTitle(span, task) {
  const input = h("input", { class: "inline title-edit", type: "text", value: task.title, "aria-label": "Titre" });
  span.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    if (save && value && value !== task.title) {
      try { await api("PATCH", `/api/tasks/${task.id}`, { title: value }); } catch {}
    }
    load();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

// Modification de la date : champs date + heure.
// Sans date existante, on propose aujourd'hui à 18h ; l'heure retombe sur 18h si elle est vidée.
function editTaskDate(button, task, { allowClear = true } = {}) {
  const [d0, t0] = task.due_at ? task.due_at.split("T") : [todayStr(), DEFAULT_TIME];
  const date = h("input", { class: "inline", type: "date", value: d0, "aria-label": "Date limite" });
  const time = h("input", { class: "inline", type: "time", value: t0 || DEFAULT_TIME, "aria-label": "Heure" });
  const clear = h("button", { class: "clear", type: "button" }, "effacer");
  // mousedown + preventDefault : le champ ne perd pas le focus avant le clic.
  clear.addEventListener("mousedown", (e) => e.preventDefault());
  clear.addEventListener("click", () => finish("clear"));

  const wrap = h("span", { class: "date-edit" }, date, time, task.due_at && allowClear ? clear : null);
  button.replaceWith(wrap);
  date.focus();

  const changed = () => date.value !== d0 || (time.value || DEFAULT_TIME) !== (t0 || DEFAULT_TIME);

  let finished = false;
  async function finish(mode) {
    if (finished) return;
    finished = true;

    let payload = null;
    if (mode === "clear") {
      payload = { due_at: null };
    } else if ((mode === "enter" && (!task.due_at || changed())) || (mode === "blur" && changed())) {
      if (date.value) payload = { due_at: `${date.value}T${time.value || DEFAULT_TIME}` };
      else if (allowClear) payload = { due_at: null };
    }
    if (payload) {
      try { await api("PATCH", `/api/tasks/${task.id}`, payload); } catch {}
    }
    load();
  }

  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish("enter");
    if (e.key === "Escape") finish("cancel");
  });
  // On ne termine que si le focus sort de l'ensemble date + heure.
  wrap.addEventListener("focusout", (e) => {
    if (wrap.contains(e.relatedTarget)) return;
    finish("blur");
  });
}

function renderAddTask(project) {
  const wrap = h("div", { class: "add-task-wrap" });

  const showLink = () => {
    wrap.replaceChildren(
      h(
        "button",
        {
          class: "add-task-link",
          onclick: () => {
            addingTaskIn = project.id;
            showForm();
          },
        },
        h("span", { class: "plus", "aria-hidden": "true" }),
        "nouvelle tâche"
      )
    );
  };

  const showForm = () => {
    const title = h("input", { type: "text", placeholder: "Titre de la tâche", "aria-label": "Titre de la tâche", required: true });

    // La date est optionnelle : « + date » la fait apparaître, préremplie (aujourd'hui, 18h).
    const dateSlot = h("span", { class: "date-slot" });
    let dueInputs = null;

    function showDateButton() {
      dueInputs = null;
      dateSlot.replaceChildren(h("button", { class: "btn secondary", type: "button", onclick: showDateInputs }, "+ date"));
    }
    function showDateInputs() {
      const date = h("input", { type: "date", value: todayStr(), "aria-label": "Date limite" });
      const time = h("input", { type: "time", value: DEFAULT_TIME, "aria-label": "Heure" });
      const remove = h("button", { class: "btn secondary", type: "button", title: "Retirer la date", "aria-label": "Retirer la date", onclick: showDateButton }, "✕");
      dueInputs = { date, time };
      dateSlot.replaceChildren(date, time, remove);
    }
    showDateButton();

    const cancel = h(
      "button",
      {
        class: "btn secondary",
        type: "button",
        onclick: () => {
          addingTaskIn = null;
          showLink();
        },
      },
      "Annuler"
    );

    const form = h("form", { class: "add-task" }, title, dateSlot, h("button", { class: "btn", type: "submit" }, "Ajouter"), cancel);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const value = title.value.trim();
      if (!value) return;
      const due = dueInputs && dueInputs.date.value ? `${dueInputs.date.value}T${dueInputs.time.value || DEFAULT_TIME}` : null;
      try {
        await api("POST", `/api/projects/${project.id}/tasks`, { title: value, due_at: due });
      } catch {
        return;
      }
      addingTaskIn = project.id; // le formulaire reste ouvert pour enchaîner
      load();
    });
    form.addEventListener("keydown", (e) => {
      if (e.key === "Escape") cancel.click();
    });

    wrap.replaceChildren(form);
    title.focus();
  };

  if (addingTaskIn === project.id) showForm();
  else showLink();
  return wrap;
}

/* ---------- Projets : menu, renommage, largeur ---------- */

let openMenuEl = null;
document.addEventListener("click", (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});

// Si la souris est relâchée sans glisser, on désactive le glisser-déposer.
document.addEventListener("mouseup", () => {
  document.querySelectorAll('.project[draggable="true"], .task[draggable="true"]').forEach((el) => (el.draggable = false));
});

function closeMenu() {
  if (!openMenuEl) return;
  openMenuEl.querySelector(".menu-btn")?.setAttribute("aria-expanded", "false");
  openMenuEl.querySelector(".menu")?.remove();
  openMenuEl = null;
}

function renderMenu(nameEl, project) {
  const wrap = h("div", { class: "menu-wrap" });
  const btn = h("button", { class: "menu-btn", "aria-label": "Options du projet", "aria-haspopup": "true", "aria-expanded": "false" }, "⋯");

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = openMenuEl === wrap;
    closeMenu();
    if (wasOpen) return;

    const menu = h(
      "div",
      { class: "menu" },
      h(
        "button",
        {
          onclick: () => {
            closeMenu();
            editProjectName(nameEl, project);
          },
        },
        "Renommer"
      ),
      h(
        "button",
        {
          onclick: async () => {
            closeMenu();
            try { await api("PATCH", `/api/projects/${project.id}`, { own_row: !project.own_row }); } catch {}
            load();
          },
        },
        (project.own_row ? "✓ " : "") + "Sur sa propre ligne"
      ),
      h(
        "div",
        { class: "swatches", role: "group", "aria-label": "Couleur du projet" },
        h("div", { class: "menu-label" }, "Couleur"),
        [["", "Aucune"], ...COLORS].map(([key, label]) => {
          const selected = key === (project.color || "");
          return h("button", {
            class: "swatch" + (key ? "" : " none") + (selected ? " selected" : ""),
            style: key ? `--sw: var(--c-${key})` : null,
            title: label,
            "aria-label": label,
            "aria-pressed": String(selected),
            onclick: async () => {
              closeMenu();
              try { await api("PATCH", `/api/projects/${project.id}`, { color: key }); } catch {}
              load();
            },
          });
        })
      ),
      h(
        "button",
        {
          class: "danger",
          onclick: async () => {
            closeMenu();
            const n = project.tasks.length;
            const msg = n
              ? `Supprimer le projet « ${project.name} » et ses ${n} tâche${n > 1 ? "s" : ""} ?`
              : `Supprimer le projet « ${project.name} » ?`;
            if (!confirm(msg)) return;
            try { await api("DELETE", `/api/projects/${project.id}`); } catch {}
            load();
          },
        },
        "Supprimer le projet"
      )
    );
    wrap.append(menu);
    btn.setAttribute("aria-expanded", "true");
    openMenuEl = wrap;
  });

  wrap.append(btn);
  return wrap;
}

function editProjectName(nameEl, project) {
  if (!nameEl.isConnected) return;
  const input = h("input", { class: "inline name-edit", type: "text", value: project.name, "aria-label": "Nom du projet" });
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    if (save && value && value !== project.name) {
      try { await api("PATCH", `/api/projects/${project.id}`, { name: value }); } catch {}
    }
    load();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

// Poignée sur le bord droit : glisser pour élargir ou réduire le projet.
function renderResizeHandle(card, project) {
  const handle = h("div", {
    class: "resize-handle",
    title: "Glisser pour changer la largeur",
    role: "separator",
    "aria-orientation": "vertical",
  });

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);

    const startX = e.clientX;
    const startW = card.getBoundingClientRect().width;
    const maxW = projectsEl.clientWidth;
    let w = startW;

    const move = (ev) => {
      w = Math.max(MIN_WIDTH, Math.min(maxW, startW + ev.clientX - startX));
      card.style.setProperty("--w", w + "px");
    };
    const up = async () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      if (Math.round(w) === Math.round(startW)) return;
      try { await api("PATCH", `/api/projects/${project.id}`, { width: Math.round(w) }); } catch {}
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });

  return handle;
}

/* ---------- Nouveau projet ---------- */

function showAddProjectButton() {
  newProjectSlot.replaceChildren(
    h("button", { class: "add-link", onclick: showAddProjectForm }, h("span", { class: "plus", "aria-hidden": "true" }), "nouveau projet")
  );
}

function showAddProjectForm() {
  const input = h("input", { type: "text", placeholder: "Nom du projet", "aria-label": "Nom du projet", required: true });
  const form = h(
    "form",
    { class: "new-project" },
    input,
    h("button", { class: "btn", type: "submit" }, "Créer"),
    h("button", { class: "btn secondary", type: "button", onclick: showAddProjectButton }, "Annuler")
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    let project;
    try {
      project = await api("POST", "/api/projects", { name });
    } catch {
      return;
    }
    addingTaskIn = project.id; // on enchaîne directement sur la première tâche
    showAddProjectButton();
    load();
  });
  form.addEventListener("keydown", (e) => {
    if (e.key === "Escape") showAddProjectButton();
  });

  newProjectSlot.replaceChildren(form);
  input.focus();
}

/* ---------- Glisser-déposer ---------- */

let draggedProject = null;
let draggedTask = null;

projectsEl.addEventListener("dragover", (e) => {
  if (!draggedProject) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";

  const over = e.target.closest(".project");
  if (!over) {
    if (e.target === projectsEl) projectsEl.append(draggedProject); // zone vide : à la fin
    return;
  }
  if (over === draggedProject) return;

  // Les projets ont des largeurs différentes : sur la même ligne on compare
  // à l'horizontale, sinon à la verticale.
  const r = over.getBoundingClientRect();
  const d = draggedProject.getBoundingClientRect();
  const sameRow = d.top < r.bottom && d.bottom > r.top;
  const after = sameRow ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;

  if (after && over.nextElementSibling !== draggedProject) over.after(draggedProject);
  else if (!after && over.previousElementSibling !== draggedProject) over.before(draggedProject);
});

// Évite que le navigateur n'interprète le dépôt (ex. Firefox) comme une navigation.
projectsEl.addEventListener("drop", (e) => {
  if (draggedProject || draggedTask) e.preventDefault();
});

async function onProjectDragEnd() {
  if (!draggedProject) return;
  const card = draggedProject;
  draggedProject = null;
  card.classList.remove("dragging");
  card.draggable = false;

  const ids = [...projectsEl.querySelectorAll(":scope > .project")].map((el) => Number(el.dataset.id));
  try {
    await api("PUT", "/api/projects/order", { ids });
  } catch {
    load();
  }
}

async function onTaskDragEnd() {
  if (!draggedTask) return;
  const li = draggedTask;
  draggedTask = null;
  li.classList.remove("dragging");
  li.draggable = false;

  const card = li.closest(".project");
  const projectID = Number(card.dataset.id);
  const ids = [...card.querySelectorAll(".tasks:not(.done-list) > .task")].map((el) => Number(el.dataset.id));
  try {
    await api("PUT", `/api/projects/${projectID}/tasks/order`, { ids });
  } catch {
    load();
  }
}

/* ---------- Démarrage ---------- */

applyTab();
showAddProjectButton();
load();
