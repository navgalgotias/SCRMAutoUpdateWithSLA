/*
 * Deployment config for vTiger CRM Auto Update.
 *
 * userApiUrl: the Web app URL of the Apps Script in apps-script/Code.gs
 * (Apps Script → Deploy → Manage deployments → Web app URL, ends in /exec).
 * Sign-in and the Users list both go through it — see README.md →
 * "User database (Google Sheet)". This URL is not a secret.
 */
window.CRM_AUTO_UPDATE_CONFIG = {
  userApiUrl: "https://script.google.com/macros/s/AKfycbyYpAvLzoU5ggHDhKU1jiAN7HSlQn5_3EvtrLgd-qkG2mmfvrcyUTMsWAtua8VF_DXcbA/exec",

  /*
   * Ticket SLA tab — the same rules as crmsla.altametrics.com → Settings.
   * Keep these in step with that app until it is retired. See README.md →
   * "Ticket SLA".
   */
  sla: {
    // SLA limit in hours, per severity.
    limits: { High: 8, Medium: 72, Low: 168 },
    // A ticket is "approaching" breach once this few hours remain.
    approaching: { High: 2, Medium: 24, Low: 48 },
    // Whole days left out of SLA hours (0 = Sunday … 6 = Saturday).
    excludedWeekdays: [0, 6],
    // Whole dates left out of SLA hours (YYYY-MM-DD).
    holidays: ["2026-05-25", "2026-07-03", "2026-08-28", "2026-09-07", "2026-10-02", "2026-11-26", "2026-11-27"],
    // Load tickets created in the last N days, counted as whole days in reportTimezone
    // (today and the N-1 days before it) — the same window as the CRM SLA report.
    lookbackDays: 30,
    reportTimezone: "Asia/Kolkata",
    // Organizations the CRM SLA report leaves out (matched by name, any case).
    excludeOrganizations: ["AnyConnector"],
    // Rows in the Daily Operation Stats table (today and the days before it).
    dosDays: 11,
    // Timezone vTiger's Webservice returns createdtime in.
    crmTimezone: "UTC",
    // Timezone the free-text "Internal Closed Time" values are written in.
    internalClosedTimezone: "Asia/Kolkata",
    // vTiger fields, found by their on-screen label. Put an API name (e.g. "cf_1234")
    // in place of a label to pin a field if the label ever changes.
    fields: {
      ticketNo: "Ticket Number",
      title: "Title",
      organization: "Organization Name",
      severity: "Severity",
      internalSeverity: "Internal Severity",
      internalStatus: "Internal Status",
      internalClosedTime: "Internal Closed Time",
      createdTime: "Created Time",
    },
  },
};
