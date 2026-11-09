/**
 * Campaign Export Utilities for CSV, Google Sheets, and Notion
 */

import type { ProspectRow } from "@/components/outreach/prospect-table";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";

function escapeCsvField(field: unknown): string {
  if (field === null || field === undefined) return "";
  const str = String(field);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function escapeTsvField(field: unknown): string {
  if (field === null || field === undefined) return "";
  return String(field).replace(/[\t\r\n]+/g, " ").trim();
}

function escapeMdCell(field: unknown): string {
  if (field === null || field === undefined) return "";
  return String(field).replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();
}

/**
 * Builds standard CSV content for campaign prospects
 */
export function generateCampaignCsv(campaignName: string, prospects: ProspectRow[]): string {
  const headers = [
    "Full Name",
    "Job Title",
    "Company",
    "Location",
    "Email",
    "LinkedIn URL",
    "Pipeline Status",
    "Effectiveness Match",
    "Alma Mater / Education",
    "Recent News Catalyst",
    "Latest Subject",
    "Latest Message Body",
  ];

  const rows = prospects.map((p) => {
    const enrichment = (p.enrichment || {}) as Record<string, unknown>;
    const score = typeof enrichment.effectivenessScore === "number" ? `${enrichment.effectivenessScore}%` : "";
    const education = (enrichment.education as string) || (enrichment.almaMater as string) || "";
    const news = (enrichment.newsContext as string) || (enrichment.recentNews as string) || "";
    const subject = p.message?.subject || "";
    const body = p.message?.body || "";

    return [
      escapeCsvField(p.fullName),
      escapeCsvField(p.title),
      escapeCsvField(p.company),
      escapeCsvField(p.location),
      escapeCsvField(p.email),
      escapeCsvField(p.linkedinUrl),
      escapeCsvField(p.pipeline || p.status),
      escapeCsvField(score),
      escapeCsvField(education),
      escapeCsvField(news),
      escapeCsvField(subject),
      escapeCsvField(body),
    ].join(",");
  });

  return [headers.join(","), ...rows].join("\r\n");
}

/**
 * Downloads a CSV file client-side
 */
export function downloadCampaignCsv(campaignName: string, prospects: ProspectRow[]): void {
  const csv = generateCampaignCsv(campaignName, prospects);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const cleanName = (campaignName || "Campaign").replace(/[^a-zA-Z0-9_-]/g, "_");

  link.setAttribute("href", url);
  link.setAttribute("download", `${cleanName}_Orbit_Outreach.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  toast.success(`Exported ${prospects.length} prospects to CSV`);
}

/**
 * Builds Tab-Separated Values (TSV) for direct paste into Google Sheets
 */
export function generateGoogleSheetsTsv(prospects: ProspectRow[]): string {
  const headers = [
    "Full Name",
    "Role",
    "Company",
    "Location",
    "Email",
    "LinkedIn URL",
    "Status",
    "Match %",
    "Education",
    "News Hook",
    "Latest Subject",
    "Draft Message",
  ];

  const rows = prospects.map((p) => {
    const enrichment = (p.enrichment || {}) as Record<string, unknown>;
    const score = typeof enrichment.effectivenessScore === "number" ? `${enrichment.effectivenessScore}%` : "";
    const education = (enrichment.education as string) || (enrichment.almaMater as string) || "";
    const news = (enrichment.newsContext as string) || (enrichment.recentNews as string) || "";
    const subject = p.message?.subject || "";
    const body = p.message?.body || "";

    return [
      escapeTsvField(p.fullName),
      escapeTsvField(p.title),
      escapeTsvField(p.company),
      escapeTsvField(p.location),
      escapeTsvField(p.email),
      escapeTsvField(p.linkedinUrl),
      escapeTsvField(p.pipeline || p.status),
      escapeTsvField(score),
      escapeTsvField(education),
      escapeTsvField(news),
      escapeTsvField(subject),
      escapeTsvField(body),
    ].join("\t");
  });

  return [headers.join("\t"), ...rows].join("\n");
}

/**
 * Copies TSV to clipboard and opens Google Sheets in a new tab
 */
export async function openGoogleSheetsWithData(campaignName: string, prospects: ProspectRow[]): Promise<boolean> {
  const tsv = generateGoogleSheetsTsv(prospects);
  const ok = await copyText(tsv);
  if (!ok) {
    toast.error("Failed to copy data to clipboard");
    return false;
  }

  // Open Google Sheets create in new tab
  window.open("https://sheets.new", "_blank", "noopener,noreferrer");
  toast.success(
    `Copied ${prospects.length} prospects to clipboard! Press Cmd+V (or Ctrl+V) in your new Google Sheet to paste.`
  );
  return true;
}

/**
 * Builds Markdown table for direct paste into Notion database / page
 */
export function generateNotionMarkdownTable(prospects: ProspectRow[]): string {
  const headers = [
    "Name",
    "Role",
    "Company",
    "Location",
    "Email",
    "Status",
    "Match Score",
    "Education",
    "News Catalyst",
    "LinkedIn",
  ];

  const divider = [
    "---",
    "---",
    "---",
    "---",
    "---",
    "---",
    "---",
    "---",
    "---",
    "---",
  ];

  const rows = prospects.map((p) => {
    const enrichment = (p.enrichment || {}) as Record<string, unknown>;
    const score = typeof enrichment.effectivenessScore === "number" ? `${enrichment.effectivenessScore}%` : "-";
    const education = (enrichment.education as string) || (enrichment.almaMater as string) || "-";
    const news = (enrichment.newsContext as string) || (enrichment.recentNews as string) || "-";
    const linkedin = p.linkedinUrl ? `[LinkedIn](${p.linkedinUrl})` : "-";

    return `| ${[
      escapeMdCell(p.fullName),
      escapeMdCell(p.title || "-"),
      escapeMdCell(p.company || "-"),
      escapeMdCell(p.location || "-"),
      escapeMdCell(p.email || "-"),
      escapeMdCell(p.pipeline || p.status),
      escapeMdCell(score),
      escapeMdCell(education),
      escapeMdCell(news),
      linkedin,
    ].join(" | ")} |`;
  });

  return [
    `| ${headers.join(" | ")} |`,
    `| ${divider.join(" | ")} |`,
    ...rows,
  ].join("\n");
}

/**
 * Copies Notion-compatible Markdown table to clipboard
 */
export async function copyNotionTable(prospects: ProspectRow[]): Promise<boolean> {
  const table = generateNotionMarkdownTable(prospects);
  const ok = await copyText(table);
  if (!ok) {
    toast.error("Failed to copy Notion table to clipboard");
    return false;
  }

  toast.success(
    `Copied ${prospects.length} prospects as a Notion table! Paste (Cmd+V / Ctrl+V) on any blank Notion page.`
  );
  return true;
}
