// Indexable pages only; rooms are private and short-lived.
import type { APIRoute } from "astro";

const PAGES = [
  { path: "/", changefreq: "weekly", priority: "1.0" },
  { path: "/about/", changefreq: "monthly", priority: "0.8" },
  { path: "/privacy/", changefreq: "yearly", priority: "0.4" },
  { path: "/terms/", changefreq: "yearly", priority: "0.4" },
];
const LASTMOD = "2026-11-07";

export const GET: APIRoute = ({ site }) => {
  const urls = PAGES.map(
    (p) =>
      `  <url><loc>${new URL(p.path, site)}</loc><lastmod>${LASTMOD}</lastmod><changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`,
  ).join("\n");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, {
    headers: { "Content-Type": "application/xml" },
  });
};
