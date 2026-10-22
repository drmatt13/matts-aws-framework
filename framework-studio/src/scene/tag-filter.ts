import type { ModeModel } from "../../shared/model";
import type { Scene } from "./build";
import { tagSceneMatches } from "./focus";

/** A presentation overlay: retain the exact topology, routing, lanes and presence. */
export function filterSceneByTag(scene: Scene, model: ModeModel, key: string, value: string | null): Scene {
  const matches = tagSceneMatches(scene, model, key, value);
  return { ...scene,
    nodes: scene.nodes.map(node => matches.nodes.has(node.id) ? node : { ...node, tagFiltered: true }),
    props: scene.props.map(prop => matches.props.has(prop.id) ? prop : { ...prop, tagFiltered: true }),
  };
}
