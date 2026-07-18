export class ClinicalLanguageFormatter {
  static execute(note) {
    let formattedNote = note;

    // Clean up negative negations
    formattedNote = formattedNote.replace(/No no /g, "Denies ");
    formattedNote = formattedNote.replace(/- No denies /gi, "- Denies ");
    
    // Clean up normal findings if they accidentally got negated
    formattedNote = formattedNote.replace(/- No normal (\w+)/gi, (match, p1) => {
       return `- ${p1.charAt(0).toUpperCase() + p1.slice(1)} normal`;
    });

    // General syntax cleanup
    formattedNote = formattedNote.replace(/ \./g, ".");
    formattedNote = formattedNote.replace(/\s{3,}/g, "\n\n");

    return formattedNote;
  }
}
