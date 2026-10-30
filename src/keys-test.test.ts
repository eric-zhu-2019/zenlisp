import { beforeEach, describe, expect, it, vi } from "vitest";
import * as actions from "./actions";
import { testProject } from "./keys";
import type { SystemInfo } from "./protocol/SystemInfo";
import { set } from "./store";

vi.mock("./actions");

const system = (name: string) => ({ name }) as SystemInfo;
const project = { root: "/p", name: "p", managers: [] };

describe("⌘U", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    set({ status: { session: { state: "stopped" }, project }, systems: [], tests: null });
  });

  it("tests the first system", async () => {
    set({ systems: [system("app"), system("app/tests")] });
    await testProject();
    expect(actions.testSystem).toHaveBeenCalledWith("app");
  });

  it("reads the systems first when pressed before they are listed", async () => {
    vi.mocked(actions.refreshSystems).mockImplementation(async () => set({ systems: [system("app")] }));
    await testProject();
    expect(actions.testSystem).toHaveBeenCalledWith("app");
  });

  it("says so when the project has no system", async () => {
    await testProject();
    expect(actions.testSystem).not.toHaveBeenCalled();
    expect(actions.flash).toHaveBeenCalledWith("This project has no system to test", "error");
  });

  it("says so when no project is open", async () => {
    set({ status: { session: { state: "stopped" }, project: null } });
    await testProject();
    expect(actions.refreshSystems).not.toHaveBeenCalled();
    expect(actions.flash).toHaveBeenCalledWith("Open a project to run its tests");
  });
});
