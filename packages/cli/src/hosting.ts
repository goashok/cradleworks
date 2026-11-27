// What a service that runs the factory for others builds on: the CLI itself, the Postgres store,
// the work item model, the console's wording, the settings tools, setting a repository up, and
// measuring. It is the entry point of the published package (`cradleworks/hosting`); everything
// else in the package may change between versions without notice.

export { run, commandFor, defaultRegistry } from './index.ts';
export { PostgresStateStore } from '@cradleworks/store-postgres';
export { WorkItemRepository, EventSpecStore } from '@cradleworks/core';
export { costByRun, headline, story, taskState, waitsForPerson } from './console-view.ts';
export { needsPerson } from './console-dashboard.ts';
export { formatLog } from './log.ts';
export { FACTORY_YAML, DEFAULTS_PATH, parseProjectConfig, formatIssue, loadProjectConfig } from '@cradleworks/config';
export { explain } from './explain.ts';
export { tokenProviderFromEnv } from '@cradleworks/adapter-github';
export { detectStack, renderFactoryYaml, renderDockerfile } from './init/detect.ts';
export { loadSuite, loadTask } from './eval/suite.ts';
export { compare } from './eval/report.ts';
export { factoryVersion } from './version.ts';
/** The YAML library the factory edits settings with, so edits keep comments the same way. */
export * as yaml from 'yaml';
