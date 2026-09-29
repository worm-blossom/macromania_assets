import { evaluate } from "macromania";

import { ConfigFs, Dir, File } from "@wormblossom/macromania-fs";
import { SimpleFsDeno } from "@wormblossom/simple-fs-deno";
import { Assets } from "../src/mod.tsx";

const exp = (
  <ConfigFs fs={new SimpleFsDeno(".")}>
    <Dir name="build" mode="assertive">
      <Assets transformations={[]} input="assets" output="assetsOut">
        <File name="z">z</File>
      </Assets>
    </Dir>
  </ConfigFs>
);

await evaluate(exp);
