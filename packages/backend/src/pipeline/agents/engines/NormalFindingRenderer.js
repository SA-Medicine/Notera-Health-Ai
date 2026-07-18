export class NormalFindingRenderer {
  static render(entities) {
    const normalFindings = entities.filter(e => e.entity_type === "normal_finding");
    if (normalFindings.length === 0) return "";

    let output = `**Normal Findings:**\n`;
    normalFindings.forEach(e => {
      e.render_status = "rendered";
      e.render_reason = "normal_finding_section";
      output += `- ${e.display_text}\n`;
    });

    return output + "\n";
  }
}
