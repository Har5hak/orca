import { isSafeDisplayCharacter } from '../../../shared/skill-display-text'

/** Keeps one untrusted receipt field from creating terminal controls or forged output rows. */
export function orchestrationTerminalSafeLine(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return isSafeDisplayCharacter(character) && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
    })
    .join('')
}
