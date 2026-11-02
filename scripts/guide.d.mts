export interface GuideHeading {
  /** GitHub-style id, as in the guide's own "#…" links */
  id: string;
  depth: number;
  text: string;
  /** Where the section starts and ends in `html` (its heading through its subsections) */
  start: number;
  end: number;
}

export function plain(html: string): string;

export function renderGuide(markdown: string): {
  html: string;
  title: string;
  headings: GuideHeading[];
  /** "#…" links that match no heading */
  brokenLinks: string[];
};
