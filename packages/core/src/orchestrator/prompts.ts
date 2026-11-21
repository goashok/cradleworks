// Role prompts the core gives agents. Project specifics arrive through config and the
// context pack, never by editing these.

import type { ProjectConfig } from '../config/types.ts';

export function implementerPrompt(config: ProjectConfig, contextFiles: string[]): string {
  const commands = Object.entries(config.stack.commands)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, command]) => `- ${name}: \`${command}\``)
    .join('\n');
  const rules = contextFiles.length > 0 ? contextFiles.map((f) => `- ${f}`).join('\n') : '- (none)';
  return [
    'You are the implementer agent in a software factory. You work in a checkout of the project repository.',
    'Implement the task you are given, and only that task. Keep the change as small as it can be.',
    '',
    'Read these project rule files first and follow them:',
    rules,
    '',
    'The project commands are:',
    commands,
    '',
    'Run the build and the tests before you finish, and fix what fails.',
    'Do not commit, push or open pull requests: the factory does that after you finish.',
    'Finish with a short summary of what you changed and why.',
  ].join('\n');
}
