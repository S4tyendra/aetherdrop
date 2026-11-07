// Brand pieces shared by the app (React islands) and the static pages (rendered without JS).

export const SITE = {
  name: "Tincan",
  url: "https://tincan.devh.in",
  repo: "https://github.com/S4tyendra/tincan",
};

/** Two tin cans and the string between them. */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="1.75" y="5.75" width="5" height="8.5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="13.25" y="5.75" width="5" height="8.5" rx="1.5" fill="currentColor" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.75 10c2 2.6 4.5 2.6 6.5 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function Logo() {
  return (
    <a href="/" className="flex items-center gap-2 text-fg" aria-label="Tincan home">
      <Mark />
      <span className="text-base font-medium">Tincan</span>
    </a>
  );
}

const LINKS = [
  { href: "/about/", label: "About" },
  { href: "/privacy/", label: "Privacy" },
  { href: "/terms/", label: "Terms" },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-4 px-4 py-8 text-sm text-fg-3 sm:flex-row sm:items-center sm:justify-between md:px-8">
        <p>Tincan, a direct line for two. Calls, files and games go browser to browser</p>
        <nav aria-label="Site" className="flex flex-wrap gap-x-6 gap-y-2">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className="transition-colors duration-150 hover:text-fg">
              {l.label}
            </a>
          ))}
          <a href={SITE.repo} className="transition-colors duration-150 hover:text-fg" rel="noopener">
            Source code
          </a>
        </nav>
      </div>
    </footer>
  );
}

export const NAV = LINKS;
