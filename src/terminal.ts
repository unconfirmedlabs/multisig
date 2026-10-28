import { assert, CliError } from './errors.ts';

export function terminalText(value: string): string {
  return value.replace(
    /[\p{Cc}\p{Cf}]/gu,
    (char) => `\\u${char.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  );
}

export class Terminal {
  private readonly input = Bun.stdin.stream().getReader();
  private readonly decoder = new TextDecoder();
  private buffer = '';

  write(text: string) {
    process.stderr.write(text);
  }

  async choose<T>(title: string, items: ReadonlyArray<{ label: string; value: T }>): Promise<T> {
    assert(items.length > 0, 'NOTHING_TO_SELECT', 'No matching items are available.');
    this.write(`\n${title}\n`);
    items.forEach((item, index) => this.write(`  ${index + 1}) ${terminalText(item.label)}\n`));
    for (;;) {
      this.write(`Select 1–${items.length}, or q to cancel: `);
      const text = (await this.line()).trim();
      if (text.toLowerCase() === 'q')
        throw new CliError({ code: 'CANCELLED', message: 'Selection cancelled.' });
      if (/^[1-9][0-9]*$/.test(text)) {
        const index = Number(text) - 1;
        if (Number.isSafeInteger(index) && index < items.length) return items[index]!.value;
      }
      this.write('Enter one of the listed numbers.\n');
    }
  }

  private async line(): Promise<string> {
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        return line;
      }
      const next = await this.input.read();
      assert(!next.done, 'CANCELLED', 'Terminal input closed.');
      this.buffer += this.decoder.decode(next.value, { stream: true });
      assert(this.buffer.length <= 4096, 'INVALID_INPUT', 'Terminal input is too long.');
    }
  }

  close() {
    this.input.releaseLock();
  }
}
