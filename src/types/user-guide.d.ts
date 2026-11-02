// Built by the userGuide() plugin in vite.config.ts from docs/USER-GUIDE.md (CO-9).

declare module 'virtual:user-guide' {
  const guide: {
    /** The whole guide, rendered */
    html: string;
    /** Each heading's section in `html`, by its GitHub-style id */
    sections: Record<string, { title: string; start: number; end: number }>;
  };
  export default guide;
}
