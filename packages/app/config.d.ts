export interface Config {
  /** everesto.live portal settings */
  everesto?: {
    /**
     * Show DUMMY metrics (builds, coverage, vulnerabilities, deploys …) on the
     * DevOps Space pages. true only for local layout previews (app-config.local.yaml);
     * production shows "connect X to see data" until each tool's plugin is wired.
     * @visibility frontend
     */
    demoData?: boolean;
  };
}
