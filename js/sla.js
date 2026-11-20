/* =============================================================================
 * Ticket SLA tab — the CRM SLA monitoring dashboard (crmsla.altametrics.com),
 * fed straight from vTiger instead of an uploaded CSV report.
 *
 * The calculations reproduce that app's own (worked out against its output
 * for the CRM_RPT_8.1 "SLA Reports" CSV; see README.md → "Ticket SLA"):
 *   - SLA hours run 24h a day, skipping excluded weekdays and holidays whole.
 *   - Breach time = created + the severity's limit in SLA hours.
 *   - Severity = Internal Severity, else the client's Severity "(client)".
 *   - Remaining hours = SLA hours from now to breach time, rounded.
 *   - Closed time = Internal Closed Time.
 * All date math is done on "wall-clock" milliseconds in the selected
 * timezone (a Date whose UTC fields read as the local time there), so a day
 * is always exactly 24 hours and day/week boundaries are that timezone's.
 * ========================================================================== */
(function () {
  "use strict";

  const bridge = window.CrmBridge;
  if (!bridge) return;

  const RULES = Object.assign({
    limits: { High: 8, Medium: 72, Low: 168 },
    approaching: { High: 2, Medium: 24, Low: 48 },
    excludedWeekdays: [0, 6],
    holidays: [],
    lookbackDays: 30,
    excludeOrganizations: [],
    dosDays: 11,
    crmTimezone: "UTC",
    internalClosedTimezone: "Asia/Kolkata",
    reportTimezone: "Asia/Kolkata",
    fields: {},
  }, (window.CRM_AUTO_UPDATE_CONFIG || {}).sla || {});

  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;
  const SEVERITIES = ["High", "Medium", "Low"];
  const TZ_STORAGE_KEY = "vtigerAutoUpdate.slaTimezone.v1";
  const holidaySet = new Set(RULES.holidays);
  const excludedWeekdays = new Set(RULES.excludedWeekdays);

  const $ = (id) => document.getElementById(id);
  const els = {
    tabs: document.querySelectorAll(".app-tabs .tab"),
    viewUpdate: $("view-update"),
    viewSla: $("view-sla"),
    timezone: $("sla-timezone"),
    btnRefresh: $("sla-btn-refresh"),
    btnErrors: $("sla-btn-errors"),
    errorCount: $("sla-error-count"),
    status: $("sla-status"),
    openCount: $("sla-open-count"),
    openBody: $("sla-open-body"),
    dosCount: $("sla-dos-count"),
    dosBody: $("sla-dos-body"),
    breachOverall: $("sla-breach-overall"),
    breachSummary: $("sla-breach-summary"),
    breachBody: $("sla-breach-body"),
    errorOverlay: $("sla-error-overlay"),
    errorClose: $("sla-error-close"),
    errorIntro: $("sla-error-intro"),
    errorList: $("sla-error-list"),
  };

  const sla = {
    tickets: null, // normalized tickets from the last load, or null if never loaded
    loadErrors: [], // data problems found while normalizing
    loading: false,
    loadedAt: null,
    stale: true, // a (re)connect happened since the last load
    report: null, // last computed { open, dos, weeks, overall }
  };

  /* ---------------------------------------------------------------------
   * Timezone helpers
   * ------------------------------------------------------------------- */
  const partsFormatters = {};
  function partsIn(tz, utcMs) {
    if (!partsFormatters[tz]) {
      partsFormatters[tz] = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    }
    const p = {};
    partsFormatters[tz].formatToParts(new Date(utcMs)).forEach((x) => { p[x.type] = Number(x.value); });
    return p;
  }

  /* Instant (UTC ms) → wall-clock ms in tz. */
  function toWall(utcMs, tz) {
    const p = partsIn(tz, utcMs);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) + (utcMs % 1000 + 1000) % 1000;
  }

  /* Wall-clock ms in tz → instant (UTC ms). Two passes settle DST edges. */
  function fromWall(wallMs, tz) {
    let utc = wallMs - (toWall(wallMs, tz) - wallMs);
    utc = wallMs - (toWall(utc, tz) - utc);
    return utc;
  }

  const pad = (n) => String(n).padStart(2, "0");
  const startOfDay = (wall) => Math.floor(wall / DAY) * DAY;
  const dateKey = (wall) => {
    const d = new Date(wall);
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  };
  const formatDate = (wall) => {
    const d = new Date(wall);
    return pad(d.getUTCDate()) + "-" + pad(d.getUTCMonth() + 1) + "-" + d.getUTCFullYear();
  };
  const formatDateTime = (wall) => {
    const d = new Date(wall);
    return formatDate(wall) + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
  };
  /* Monday of the wall date's week. */
  const weekStart = (wall) => {
    const day = startOfDay(wall);
    return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
  };

  /* ---------------------------------------------------------------------
   * SLA hours
   * ------------------------------------------------------------------- */
  function isExcludedDay(wall) {
    return excludedWeekdays.has(new Date(wall).getUTCDay()) || holidaySet.has(dateKey(wall));
  }

  /* SLA hours between two wall times (0 if b is not after a). */
  function slaHoursBetween(a, b) {
    let ms = 0;
    for (let t = a; t < b;) {
      const next = Math.min(b, startOfDay(t) + DAY);
      if (!isExcludedDay(t)) ms += next - t;
      t = next;
    }
    return ms / HOUR;
  }

  /* Wall time reached after `hours` SLA hours from `start`. */
  function addSlaHours(start, hours) {
    let t = start;
    let left = hours * HOUR;
    for (let guard = 0; guard < 3650; guard += 1) {
      if (isExcludedDay(t)) { t = startOfDay(t) + DAY; continue; }
      const dayEnd = startOfDay(t) + DAY;
      if (dayEnd - t >= left) return t + left;
      left -= dayEnd - t;
      t = dayEnd;
    }
    return t;
  }

  /* PHP's round(): halves go away from zero. */
  function phpRound(value, decimals) {
    const f = Math.pow(10, decimals || 0);
    const v = Math.abs(value) * f;
    return Math.sign(value) * Math.round(Number(v.toPrecision(15))) / f;
  }
  const pct = (part, whole, decimals) => (whole ? phpRound((part / whole) * 100, decimals) : 0);

  /* ---------------------------------------------------------------------
   * Parsing
   * ------------------------------------------------------------------- */
  /* "2026-10-30 13:06:49(.899)", "10/23/2026 12:37:12", "10-22-2026 00:14:07",
   * with or without seconds or a time at all → wall ms (no timezone applied), or null. */
  function parseWall(text) {
    const s = String(text == null ? "" : text).trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/);
    let y, mo, d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else {
      m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/);
      if (!m) return null;
      mo = +m[1]; d = +m[2]; y = +m[3];
    }
    const h = +(m[4] || 0), mi = +(m[5] || 0), se = +(m[6] || 0);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
    const wall = Date.UTC(y, mo - 1, d, h, mi, se);
    return new Date(wall).getUTCDate() === d ? wall : null; // rejects 02-31 etc.
  }

  /* Text → instant, to the whole minute: the CRM SLA app keeps times as
   * dd-mm-yyyy HH:MM, and its remaining hours only match with seconds dropped. */
  function parseInstant(text, tz) {
    const wall = parseWall(text);
    return wall == null ? null : Math.floor(fromWall(wall, tz) / 60000) * 60000;
  }

  function normalizeSeverity(value) {
    const v = String(value || "").trim().toLowerCase();
    if (!v) return "";
    if (v.startsWith("high") || v === "critical" || v === "urgent") return "High";
    if (v.startsWith("med") || v.startsWith("mid") || v === "normal") return "Medium";
    if (v.startsWith("low") || v === "minor") return "Low";
    return null; // present but not recognised
  }

  /* ---------------------------------------------------------------------
   * Loading from vTiger
   * ------------------------------------------------------------------- */
  const DEFAULT_API_NAMES = {
    ticketNo: "ticket_no",
    title: "ticket_title",
    organization: "parent_id",
    severity: "ticketseverities",
    createdTime: "createdtime",
  };

  /* Turn the configured labels (or API names) into this CRM's API field names. */
  function resolveFields() {
    const fields = bridge.moduleFields() || {};
    const byLabel = {};
    Object.keys(fields).forEach((name) => {
      const label = String(fields[name].label || "").trim().toLowerCase();
      if (label && !byLabel[label]) byLabel[label] = name;
    });
    const wanted = Object.assign({
      ticketNo: "Ticket Number", title: "Title", organization: "Organization Name", severity: "Severity",
      internalSeverity: "Internal Severity", internalStatus: "Internal Status",
      internalClosedTime: "Internal Closed Time", createdTime: "Created Time",
    }, RULES.fields);

    const resolved = {};
    const missing = [];
    Object.keys(wanted).forEach((key) => {
      const want = String(wanted[key] || "").trim();
      const name = fields[want] ? want
        : byLabel[want.toLowerCase()] || (fields[DEFAULT_API_NAMES[key]] ? DEFAULT_API_NAMES[key] : null);
      if (name) resolved[key] = name;
      else missing.push(want + " (" + key + ")");
    });
    if (missing.length) {
      throw new Error("These ticket fields weren't found in vTiger: " + missing.join(", ") +
        ". Set their API names under sla.fields in js/config.js.");
    }
    return resolved;
  }

  async function queryAll(sessionName, select, where) {
    const rows = [];
    for (let offset = 0; offset < 20000; offset += 100) {
      const page = await bridge.VTiger.query(sessionName,
        select + " where " + where + " limit " + offset + ", 100;");
      rows.push.apply(rows, page || []);
      if (!page || page.length < 100) break;
    }
    return rows;
  }

  async function loadOrganizationNames(sessionName, ids) {
    const names = {};
    const list = Array.from(ids).filter((id) => /^\d+x\d+$/.test(id));
    for (let i = 0; i < list.length; i += 50) {
      const chunk = list.slice(i, i + 50);
      try {
        const rows = await bridge.VTiger.query(sessionName,
          "select accountname from Accounts where id in ('" + chunk.join("','") + "') limit 0, 100;");
        (rows || []).forEach((r) => { names[r.id] = r.accountname; });
      } catch (err) {
        console.warn("Could not load organization names:", err.message);
      }
    }
    return names;
  }

  async function loadTickets() {
    const session = bridge.session();
    if (!session) throw new Error("Not connected to vTiger — use Reconnect at the top, then try again.");

    const f = resolveFields();
    const moduleName = bridge.module() || "HelpDesk";
    const columns = Array.from(new Set(Object.values(f)));
    const select = "select " + columns.join(", ") + " from " + moduleName;

    // Same window as the CRM report the SLA app was fed: tickets created in the
    // last N days (vTiger stores createdtime in crmTimezone). Older tickets are
    // left out, as they were from the report — many old ones still carry
    // Internal Status "Open" and would otherwise flood Open Tickets.
    // The window is whole days in the report's timezone: today and the N-1 days before it.
    const fromDay = startOfDay(toWall(Date.now(), RULES.reportTimezone)) - (RULES.lookbackDays - 1) * DAY;
    const sinceWall = toWall(fromWall(fromDay, RULES.reportTimezone), RULES.crmTimezone);
    const since = new Date(sinceWall).toISOString().slice(0, 19).replace("T", " ");
    const rows = await queryAll(session.sessionName, select, f.createdTime + " >= '" + since + "'");

    const orgNames = await loadOrganizationNames(session.sessionName,
      new Set(rows.map((r) => r[f.organization]).filter(Boolean)));

    const excludedOrgs = new Set(RULES.excludeOrganizations.map((o) => String(o).trim().toLowerCase()));
    const errors = [];
    const tickets = [];
    rows.forEach((r) => {
      const ticketNo = r[f.ticketNo] || r.id;
      const organization = orgNames[r[f.organization]] || "";
      if (excludedOrgs.has(organization.trim().toLowerCase())) return; // left out of the report too
      const createdAt = parseInstant(r[f.createdTime], RULES.crmTimezone);
      if (createdAt == null) {
        errors.push({ ticketNo, field: "Created Time", message: "couldn't read \"" + r[f.createdTime] + "\"" });
        return;
      }

      const internalSeverity = normalizeSeverity(r[f.internalSeverity]);
      const clientSeverity = normalizeSeverity(r[f.severity]);
      const severity = internalSeverity || clientSeverity;
      if (!severity) {
        errors.push({ ticketNo, field: "Severity", message: "no recognisable Internal Severity or Severity (\"" +
          (r[f.internalSeverity] || "") + "\" / \"" + (r[f.severity] || "") + "\")" });
        return;
      }

      const internalStatus = String(r[f.internalStatus] || "").trim();
      const isClosed = internalStatus.toLowerCase() === "closed";
      const closedText = String(r[f.internalClosedTime] || "").trim();
      let closedAt = null;
      if (closedText) {
        closedAt = parseInstant(closedText, RULES.internalClosedTimezone);
        if (closedAt == null) {
          errors.push({ ticketNo, field: "Internal Closed Time", message: "couldn't read \"" + closedText + "\"" });
          return;
        }
      }
      if (isClosed && closedAt == null) {
        errors.push({ ticketNo, field: "Internal Closed Time", message: "Internal Status is Closed but Internal Closed Time is empty" });
        return;
      }

      tickets.push({
        id: r.id,
        ticketNo,
        title: r[f.title] || "",
        organization,
        severity,
        fromClient: !internalSeverity,
        internalSeverity: internalSeverity || "",
        isOpen: !isClosed,
        createdAt,
        closedAt: isClosed ? closedAt : null,
      });
    });

    return { tickets, errors };
  }

  /* ---------------------------------------------------------------------
   * The report
   * ------------------------------------------------------------------- */
  function buildReport(tickets, tz) {
    const nowWall = toWall(Date.now(), tz);
    const today = startOfDay(nowWall);

    const enriched = tickets.map((t) => {
      const createdWall = toWall(t.createdAt, tz);
      const breachWall = addSlaHours(createdWall, RULES.limits[t.severity]);
      const closedWall = t.closedAt == null ? null : toWall(t.closedAt, tz);
      return Object.assign({}, t, { createdWall, breachWall, closedWall });
    });

    // Open Tickets — soonest breach first.
    const open = enriched.filter((t) => t.isOpen).map((t) => {
      const remaining = nowWall <= t.breachWall
        ? slaHoursBetween(nowWall, t.breachWall)
        : -slaHoursBetween(t.breachWall, nowWall);
      return Object.assign({}, t, { remaining: phpRound(remaining) });
    }).sort((a, b) => a.breachWall - b.breachWall);

    // Daily Operation Stats — today and the days before it.
    const dos = [];
    for (let i = 0; i < RULES.dosDays; i += 1) {
      const day = today - i * DAY;
      const dayEnd = day + DAY;
      dos.push({
        day,
        openToday: enriched.filter((t) => t.createdWall >= day && t.createdWall < dayEnd).length,
        closedToday: enriched.filter((t) => t.closedWall != null && t.closedWall >= day && t.closedWall < dayEnd).length,
        eodOpen: open.filter((t) => t.createdWall < dayEnd).length,
      });
    }

    // SLA Breach — closed tickets by the week (Mon–Sun) they were closed in.
    const closed = enriched.filter((t) => t.closedWall != null)
      .map((t) => Object.assign({}, t, { breached: t.closedWall > t.breachWall, week: weekStart(t.closedWall) }));
    const weeks = [];
    if (closed.length) {
      const latest = Math.max.apply(null, closed.map((t) => t.week));
      const earliest = Math.min.apply(null, closed.map((t) => t.week));
      for (let w = latest; w >= earliest; w -= 7 * DAY) {
        const inWeek = closed.filter((t) => t.week === w);
        const row = {
          week: w,
          closed: inWeek.length,
          breached: inWeek.filter((t) => t.breached).length,
        };
        row.pct = pct(row.breached, row.closed, 0);
        SEVERITIES.forEach((sev) => {
          // Per-severity rates only count tickets with an Internal Severity.
          const ofSev = inWeek.filter((t) => !t.fromClient && t.severity === sev);
          row[sev] = pct(ofSev.filter((t) => t.breached).length, ofSev.length, 0);
        });
        weeks.push(row);
      }
    }
    const overall = { pct: pct(closed.filter((t) => t.breached).length, closed.length, 2) };
    SEVERITIES.forEach((sev) => {
      const ofSev = closed.filter((t) => !t.fromClient && t.severity === sev);
      overall[sev] = pct(ofSev.filter((t) => t.breached).length, ofSev.length, 2);
    });

    return { open, dos, weeks, overall, nowWall };
  }

  /* ---------------------------------------------------------------------
   * Rendering
   * ------------------------------------------------------------------- */
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function emptyRow(cols, text) {
    return '<tr><td colspan="' + cols + '" class="center muted sla-empty">' + escapeHtml(text) + "</td></tr>";
  }

  const severityTagClass = { High: "bubble-danger", Medium: "bubble-warning", Low: "bubble-info" };

  function render() {
    if (!sla.tickets) return;
    const r = sla.report = buildReport(sla.tickets, els.timezone.value);

    els.openCount.textContent = r.open.length;
    els.openBody.innerHTML = r.open.length ? r.open.map((t) => {
      const state = t.remaining <= 0 ? "is-breached"
        : t.remaining <= RULES.approaching[t.severity] ? "is-approaching" : "";
      const client = t.fromClient ? ' <span class="muted">(client)</span>' : "";
      return '<tr class="' + state + '">' +
        "<td>" + escapeHtml(t.ticketNo) + "</td>" +
        '<td><span class="fn-tag ' + severityTagClass[t.severity] + '">' + t.severity + "</span>" + client + "</td>" +
        '<td class="right sla-num">' + t.remaining + client + "</td>" +
        "<td>" + formatDateTime(t.breachWall) + "</td>" +
        "<td>" + escapeHtml(t.organization) + "</td>" +
        '<td class="sla-title">' + escapeHtml(t.title) + "</td>" +
        "<td>" + formatDateTime(t.createdWall) + "</td>" +
        "</tr>";
    }).join("") : emptyRow(7, "No open tickets.");

    els.dosCount.textContent = r.dos.length;
    els.dosBody.innerHTML = r.dos.map((d) => "<tr>" +
      "<td>" + formatDate(d.day) + "</td>" +
      '<td class="right sla-num">' + d.openToday + "</td>" +
      '<td class="right sla-num">' + d.closedToday + "</td>" +
      '<td class="right sla-num">' + d.eodOpen + "</td>" +
      "</tr>").join("");

    els.breachOverall.textContent = r.overall.pct + "%";
    els.breachSummary.textContent = "Low: " + r.overall.Low + "%   Mid: " + r.overall.Medium + "%   High: " + r.overall.High + "%";
    els.breachBody.innerHTML = r.weeks.length ? r.weeks.map((w) => '<tr class="' + (w.breached ? "has-breach" : "") + '">' +
      "<td>" + formatDate(w.week) + "</td>" +
      '<td class="right sla-num">' + w.closed + "</td>" +
      '<td class="right sla-num">' + w.breached + "</td>" +
      '<td class="right sla-num">' + w.pct + "</td>" +
      '<td class="right sla-num">' + w.High + "</td>" +
      '<td class="right sla-num">' + w.Medium + "</td>" +
      '<td class="right sla-num">' + w.Low + "</td>" +
      "</tr>").join("") : emptyRow(7, "No closed tickets in this period.");

    renderErrors();
  }

  function renderErrors() {
    const errors = sla.loadErrors;
    els.errorCount.textContent = errors.length;
    els.errorCount.hidden = errors.length === 0;
    els.btnErrors.classList.toggle("has-errors", errors.length > 0);
    els.errorIntro.textContent = errors.length
      ? errors.length + " ticket(s) were left out of every table because of the data problems below. Fix them in vTiger, then Refresh."
      : "No errors detected. Everything is functioning correctly and as expected.";
    els.errorList.innerHTML = errors.map((e) =>
      "<li><strong>" + escapeHtml(e.ticketNo) + "</strong> &lt;" + escapeHtml(e.field) + "&gt; — " + escapeHtml(e.message) + "</li>").join("");
  }

  function setStatus(text) {
    els.status.textContent = text;
  }

  async function refresh() {
    if (sla.loading) return;
    sla.loading = true;
    els.btnRefresh.disabled = true;
    setStatus("Loading tickets from vTiger…");
    try {
      const { tickets, errors } = await loadTickets();
      sla.tickets = tickets;
      sla.loadErrors = errors;
      sla.loadedAt = new Date();
      sla.stale = false;
      render();
      setStatus("Loaded " + tickets.length + " tickets from vTiger at " +
        sla.loadedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) +
        " (created in the last " + RULES.lookbackDays + " days)." +
        (errors.length ? " " + errors.length + " skipped — see Error." : ""));
    } catch (err) {
      setStatus("Couldn't load tickets: " + err.message);
      bridge.toast("Ticket SLA: " + err.message, "error");
    } finally {
      sla.loading = false;
      els.btnRefresh.disabled = false;
    }
  }

  /* ---------------------------------------------------------------------
   * CSV download
   * ------------------------------------------------------------------- */
  function csvCell(v) {
    const s = String(v == null ? "" : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function downloadCsv(kind) {
    const r = sla.report;
    if (!r) { bridge.toast("Load the tickets first.", "error"); return; }
    let header, rows, name;
    if (kind === "open") {
      header = ["Tickets#", "Internal Severity", "SLA Remaining Hours", "SLA Breach Time", "Organisation", "Title", "Date Created"];
      rows = r.open.map((t) => [t.ticketNo, t.severity + (t.fromClient ? " (client)" : ""), t.remaining,
        formatDateTime(t.breachWall), t.organization, t.title, formatDateTime(t.createdWall)]);
      name = "open-tickets";
    } else if (kind === "dos") {
      header = ["Date", "Open Today", "Closed Today", "EOD Open Count"];
      rows = r.dos.map((d) => [formatDate(d.day), d.openToday, d.closedToday, d.eodOpen]);
      name = "daily-operation-stats";
    } else {
      header = ["Week", "Total Closed", "Total SLA Breach", "SLA Breach %", "High Breach %", "Mid Breach %", "Low Breach %"];
      rows = r.weeks.map((w) => [formatDate(w.week), w.closed, w.breached, w.pct, w.High, w.Medium, w.Low]);
      name = "sla-breach";
    }
    const csv = [header].concat(rows).map((row) => row.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name + "-" + dateKey(r.nowWall) + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------------------------------------------------------------------
   * Wiring
   * ------------------------------------------------------------------- */
  function showView(view) {
    els.tabs.forEach((tab) => {
      const active = tab.dataset.view === view;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    els.viewUpdate.hidden = view !== "update";
    els.viewSla.hidden = view !== "sla";
    if (view === "sla" && (sla.stale || !sla.tickets)) refresh();
  }

  els.tabs.forEach((tab) => tab.addEventListener("click", () => showView(tab.dataset.view)));

  try {
    const savedTz = localStorage.getItem(TZ_STORAGE_KEY);
    if (savedTz && Array.from(els.timezone.options).some((o) => o.value === savedTz)) els.timezone.value = savedTz;
    else els.timezone.value = "Asia/Kolkata";
  } catch (_e) { els.timezone.value = "Asia/Kolkata"; }

  els.timezone.addEventListener("change", () => {
    try { localStorage.setItem(TZ_STORAGE_KEY, els.timezone.value); } catch (_e) { /* ignore */ }
    render();
  });

  els.btnRefresh.addEventListener("click", refresh);

  els.viewSla.querySelectorAll(".sla-jump a").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    const target = document.querySelector(a.getAttribute("href"));
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  }));

  els.viewSla.querySelectorAll("[data-sla-download]").forEach((b) =>
    b.addEventListener("click", () => downloadCsv(b.dataset.slaDownload)));

  els.viewSla.querySelectorAll("[data-sla-maximize]").forEach((b) => b.addEventListener("click", () => {
    const card = b.closest(".sla-card");
    const max = !card.classList.contains("is-maximized");
    card.classList.toggle("is-maximized", max);
    document.body.classList.toggle("sla-has-maximized", max);
    b.setAttribute("title", max ? "Restore" : "Maximize");
    b.querySelector("iconify-icon").setAttribute("icon", max ? "ph:arrows-in" : "ph:arrows-out");
  }));

  function closeErrors() { els.errorOverlay.hidden = true; }
  els.btnErrors.addEventListener("click", () => { renderErrors(); els.errorOverlay.hidden = false; });
  els.errorClose.addEventListener("click", closeErrors);
  els.errorOverlay.addEventListener("click", (e) => { if (e.target === els.errorOverlay) closeErrors(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeErrors();
    const max = els.viewSla.querySelector(".sla-card.is-maximized [data-sla-maximize]");
    if (max) max.click();
  });

  // Keep "SLA Remaining Hours" current while the tab is open (no refetch).
  setInterval(() => { if (!els.viewSla.hidden && sla.tickets) render(); }, 60 * 1000);

  document.addEventListener("crm:connected", () => {
    sla.stale = true;
    if (!els.viewSla.hidden) refresh();
  });

  document.addEventListener("crm:signedout", () => {
    sla.tickets = null;
    sla.report = null;
    sla.loadErrors = [];
    sla.stale = true;
    els.openBody.innerHTML = els.dosBody.innerHTML = els.breachBody.innerHTML = "";
    els.openCount.textContent = els.dosCount.textContent = "0";
    setStatus("Tickets load straight from vTiger when you open this tab.");
    showView("update");
  });

  // Exposed for checking the calculations from the console / tests.
  window.TicketSla = { RULES, buildReport, addSlaHours, slaHoursBetween, parseWall, parseInstant, toWall, fromWall, phpRound };
})();
