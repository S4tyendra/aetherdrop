// Structured data and shared copy for search engines. The FAQ is rendered on the
// home page and emitted as FAQPage JSON-LD from the same source, so they always match.

const SITE = "https://tincan.devh.in";
const REPO = "https://github.com/S4tyendra/tincan";

export const FEATURES = [
  "Peer-to-peer video and voice calls",
  "Screen sharing with tab or system audio",
  "Text chat",
  "File transfer of any size, browser to browser",
  "Tic-tac-toe, Three pieces, Connect four and Quoridor",
  "PIN-protected rooms",
  "No account and no install",
];

export const FAQ: { q: string; a: string }[] = [
  {
    q: "Is Tincan free?",
    a: "Yes. There is no account, no plan and no limit on call length or file size. Tincan is open source.",
  },
  {
    q: "Do I need to sign up or install anything?",
    a: "No. Open the site in a current browser, pick a name, create a room and send the link. The other person opens the link and joins.",
  },
  {
    q: "Is it private?",
    a: "Calls, screen shares, chat messages, game moves and files travel directly between the two browsers, encrypted with DTLS and SRTP as WebRTC requires. Our server only introduces the two browsers to each other and never receives the content.",
  },
  {
    q: "How many people can join a room?",
    a: "Two. Tincan is built for one-to-one conversations, so a third visitor sees the room as full.",
  },
  {
    q: "How big can a file be?",
    a: "There is no set limit. Files stream from one browser to the other in 512 KB blocks with Reed-Solomon error correction, so a few lost packets don't force a resend. Very large files are limited by the receiving device's memory.",
  },
  {
    q: "Does screen sharing include sound?",
    a: "Yes, when your browser offers it. Chrome and Edge can share a tab's audio on every system, and the whole system's audio on Windows and ChromeOS. Firefox shares video only.",
  },
  {
    q: "Why does a call sometimes fail to connect?",
    a: "Tincan never relays traffic through a server, so both networks must allow a direct connection. Most home and mobile networks do. Some strict corporate or campus networks block it, and then the room shows that no direct route was found.",
  },
  {
    q: "Which browsers work?",
    a: "Current versions of Chrome, Edge, Firefox and Safari on desktop and mobile. Screen sharing needs a desktop browser.",
  },
];

export const webApp = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "Tincan",
  alternateName: "Tincan rooms",
  url: `${SITE}/`,
  description:
    "Private rooms for two: peer-to-peer video calls, screen sharing with sound, chat, file transfer and games, directly between browsers.",
  applicationCategory: "CommunicationApplication",
  operatingSystem: "Any (web browser)",
  browserRequirements: "Requires a browser with WebRTC support",
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  featureList: FEATURES,
  screenshot: `${SITE}/shots/room.jpg`,
  image: `${SITE}/og.png`,
  sameAs: [REPO],
};

export const website = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Tincan",
  url: `${SITE}/`,
  description: "A direct line for two: calls, screen sharing, chat, files and games, browser to browser.",
  inLanguage: "en",
};

export const faqPage = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.map((f) => ({
    "@type": "Question",
    name: f.q,
    acceptedAnswer: { "@type": "Answer", text: f.a },
  })),
};

export function breadcrumbs(name: string, path: string) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Tincan", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name, item: `${SITE}${path}` },
    ],
  };
}

export function webPage(type: "AboutPage" | "WebPage", name: string, path: string, description: string, modified?: string) {
  return {
    "@context": "https://schema.org",
    "@type": type,
    name,
    url: `${SITE}${path}`,
    description,
    inLanguage: "en",
    isPartOf: { "@type": "WebSite", name: "Tincan", url: `${SITE}/` },
    ...(modified ? { dateModified: modified } : {}),
  };
}
