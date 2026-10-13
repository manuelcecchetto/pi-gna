import { describe, expect, it } from "vitest";
import { attachDialog } from "./attachments";

describe("attachDialog", () => {
  it("lets one picker take files and folders on macOS and Windows", () => {
    expect(attachDialog("files", "darwin").properties).toEqual(["openFile", "openDirectory", "multiSelections"]);
    expect(attachDialog("files", "win32").properties).toEqual(["openFile", "openDirectory", "multiSelections"]);
  });

  // The Linux file chooser (the desktop portal, KDE's or GTK's) picks either files or folders: asked for both, it
  // showed folders only, so no file could be attached or previewed from it.
  it("picks files on Linux, where one picker cannot take both", () => {
    expect(attachDialog("files", "linux")).toMatchObject({ title: "Attach files", properties: ["openFile", "multiSelections"] });
  });

  it("picks images for photos everywhere", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      expect(attachDialog("photos", platform)).toMatchObject({ properties: ["openFile", "multiSelections"], filters: [{ name: "Images" }] });
    }
  });
});
