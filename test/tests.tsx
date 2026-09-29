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

// /**
//  * The transformation to apply to the assets.
//  */
// transformations: Transformations;
// /**
//  * The path to the directory containing the assets (a platform-specific path, either absolute or relative to the current working directory).
//  */
// input: string;
// /**
//  * The path in the macromania-fs where to place the transformed assets.
//  */
// output: Pathish;

await evaluate(exp);
