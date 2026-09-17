/** Only an initial command block invokes Skills; prose and code remain literal. */
export function skillDirectives(text: string): { ids: string[]; prefix: string; body: string } {
  const ids: string[] = [];
  let rest = text.trimStart();
  let end = 0;
  while (rest.startsWith('/')) {
    const command = /^\/([a-z0-9][a-z0-9._-]*)(?=\s|$)/i.exec(rest);
    if (!command) break; // Native/virtual paths and punctuation are ordinary authored text.
    let id = command[1]!;
    rest = rest.slice(command[0].length).trimStart();
    if (id === 'prompt') {
      const argument = /^([a-z0-9][a-z0-9._-]*)(?=\s|$)/i.exec(rest);
      if (!argument) throw new Error('Choose a skill after /prompt.');
      id = argument[1]!;
      rest = rest.slice(argument[0].length).trimStart();
    }
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(id)) throw new Error('Invalid skill command. Choose a skill from the list.');
    if (!ids.includes(id)) ids.push(id);
    if (ids.length > 64) throw new Error('Too many selected skills.');
    end = text.length - rest.length;
  }
  return { ids, prefix: text.slice(0, end), body: text.slice(end) };
}

export function invokedSkills(text: string): string[] { return skillDirectives(text).ids; }
