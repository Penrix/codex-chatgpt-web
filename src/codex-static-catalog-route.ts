import type { PreviousAssignment } from "./codex-integration-shared";
import {
  findTopLevelAssignment,
  firstTableIndex,
  insertDocumentLine,
  parseDocument,
  removeDocumentLine,
  renderDocument,
} from "./codex-integration-document";

function sameAssignment(current: PreviousAssignment, previous: PreviousAssignment): boolean {
  return current.present === previous.present
    && (!current.present || (current.value === previous.value && current.rawLine === previous.rawLine));
}

export function installManagedModelCatalog(
  text: string,
  catalogPath: string,
  replaceExisting: boolean,
): string {
  const document = parseDocument(text);
  const current = findTopLevelAssignment(document.lines, "model_catalog_json");
  if (current.present && current.value !== catalogPath && !replaceExisting) {
    throw new Error(
      `Codex already configures model_catalog_json=${JSON.stringify(current.value)}. `
      + "Rerun with --replace-codex-route to replace it reversibly.",
    );
  }
  const line = `model_catalog_json = ${JSON.stringify(catalogPath)}`;
  if (current.index !== undefined) document.lines[current.index] = line;
  else insertDocumentLine(document, firstTableIndex(document.lines), line);
  return renderDocument(document);
}

export function restoreManagedModelCatalog(
  text: string,
  catalogPath: string,
  previous: PreviousAssignment,
  options: { allowChanged?: boolean } = {},
): string {
  const document = parseDocument(text);
  const current = findTopLevelAssignment(document.lines, "model_catalog_json");
  if (current.value === catalogPath && current.index !== undefined) {
    if (previous.present) {
      if (!previous.rawLine) throw new Error("Codex integration journal is missing the prior model_catalog_json line");
      document.lines[current.index] = previous.rawLine;
    } else {
      removeDocumentLine(document, current.index);
    }
    return renderDocument(document);
  }
  if (sameAssignment(current, previous) || options.allowChanged === true) return text;
  throw new Error("Codex model_catalog_json changed after setup; refusing to overwrite the user's newer value");
}

export function verifyManagedModelCatalogInstalled(text: string, catalogPath: string): boolean {
  const current = findTopLevelAssignment(parseDocument(text).lines, "model_catalog_json");
  return current.present && current.value === catalogPath;
}

export function verifyManagedModelCatalogRestored(text: string, previous: PreviousAssignment): void {
  const current = findTopLevelAssignment(parseDocument(text).lines, "model_catalog_json");
  if (!sameAssignment(current, previous)) {
    throw new Error("Codex model_catalog_json changed while the bridge was disconnected");
  }
}
