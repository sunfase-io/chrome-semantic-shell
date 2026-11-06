import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { SHELL_COMMAND_OPTIONS } from 'chrome-semantic-shell-shared';
import { renderCommandHelp } from './semantic-cli-core';

const root = path.resolve(__dirname, '../../../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const commands = Object.keys(SHELL_COMMAND_OPTIONS);

describe('command reference stays in sync with the DSL', () => {
  it('has offline help with a usage line for every command', () => {
    expect(renderCommandHelp()).not.toContain('undefined');
    for (const command of commands) {
      expect(renderCommandHelp(command).split('\n')[0]).toMatch(new RegExp(`^${command} +\\S`));
    }
  });

  it.each(['README.md', 'README_zh.md'])(
    'lists every command in the %s quick reference',
    (file) => {
      const text = read(file);
      expect(commands.filter((command) => !text.includes(`| \`${command}`))).toEqual([]);
    },
  );

  it('shows every command in the full CLI reference', () => {
    const lines = read('skills/chrome-shell/references/semantic-shell.md').split('\n');
    expect(
      commands.filter((command) => !lines.some((line) => new RegExp(`^${command}\\b`).test(line))),
    ).toEqual([]);
  });
});
