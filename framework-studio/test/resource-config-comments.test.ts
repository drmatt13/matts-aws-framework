import assert from "./support/assert";
import { test } from "node:test";
import { preserveResourceBuilderComments } from "../server/resource-config-comments";

test("a source value can change without moving argument, metadata or chain comments", () => {
  const before = 'resource.value(/* explanation */ "true", { /* metadata */ tags: { area: "realtime" } })\n  /* choices */ .enum("true", "false") /* trailing */';
  const desired = 'resource.value("false", { /* metadata */ tags: { area: "realtime" } }).enum("true", "false")';
  assert.equal(preserveResourceBuilderComments(before, desired), before.replace('"true", {', '"false", {'));
});

test("factory changes and mode literals retain the original call trivia", () => {
  const before = 'resource.fromEnv(/* authored key */ "OLD_NAME", { tags: { area: "fixture" } }).default(/* fallback */ "before").required(/* graph */ "dev").note("Keep // as literal text")';
  const desired = 'resource.fromEnv("OLD_NAME", { tags: { area: "fixture" } }).default("after").required("prod").note("Keep // as literal text")';
  assert.equal(preserveResourceBuilderComments(before, desired), before.replace('"before"', '"after"').replace('"dev"', '"prod"'));
  assert.equal(preserveResourceBuilderComments('resource.fromEnv(/* origin */ "OLD_NAME")', 'resource.secret("OLD_NAME")'), 'resource.secret(/* origin */ "OLD_NAME")');
});

test("new policy calls append while retained calls keep their comment positions", () => {
  const before = 'resource.value(/* setting */ "true")\n  // the choices are public\n  .enum("true", "false")';
  assert.equal(preserveResourceBuilderComments(before, 'resource.value("true").required().enum("true", "false").note("A note")'), `${before}.required().note("A note")`);
  assert.equal(preserveResourceBuilderComments('resource.fromEnv(/* origin */)', 'resource.fromEnv("ORIGINAL")'), 'resource.fromEnv(/* origin */"ORIGINAL")');
});

test("options can gain a binding pin while keeping their exact authored comments", () => {
  const before = 'resource.secret(/* source */ "API_KEY", { /* ownership */ tags: { area: "fixture" } })';
  const desired = 'resource.secret("API_KEY", { /* ownership */ tags: { area: "fixture" }, bindingPath: ["original"] })';
  assert.equal(preserveResourceBuilderComments(before, desired), 'resource.secret(/* source */ "API_KEY", { /* ownership */ tags: { area: "fixture" }, bindingPath: ["original"] })');
  assert.equal(preserveResourceBuilderComments('resource.secret(/* source */ "API_KEY")', 'resource.secret("API_KEY", { bindingPath: ["original"] })'), 'resource.secret(/* source */ "API_KEY", { bindingPath: ["original"] })');
  assert.equal(preserveResourceBuilderComments('resource.secret("API_KEY", /* option context */)', 'resource.secret("API_KEY", { bindingPath: ["original"] })'), 'resource.secret("API_KEY", /* option context */ { bindingPath: ["original"] })');
  assert.equal(preserveResourceBuilderComments(before, 'resource.value("public", { /* ownership */ tags: { area: "fixture" }, bindingPath: ["original"] })'), 'resource.value(/* source */ "public", { /* ownership */ tags: { area: "fixture" }, bindingPath: ["original"] })');
});

test("removing calls or arguments refuses any comment inside the discarded span", () => {
  for (const before of ['resource.value("true").required(/* graph */ "dev")', 'resource.value("true") /* required context */ .required("dev")']) {
    assert.equal(preserveResourceBuilderComments(before, 'resource.value("true")'), undefined);
  }
  assert.equal(preserveResourceBuilderComments('resource.value(/* setting */ "true").required("dev").note("A note")', 'resource.value("true").note("A note")'), 'resource.value(/* setting */ "true").note("A note")');
  assert.equal(preserveResourceBuilderComments('resource.fromEnv(/* source */ "NAME").required(/* graph */ "dev")', 'resource.fromEnv("NAME").required()'), undefined);
  assert.equal(preserveResourceBuilderComments('resource.fromEnv(/* source */ "NAME").required("dev")', 'resource.fromEnv("NAME").required()'), 'resource.fromEnv(/* source */ "NAME").required()');
});

test("per-mode argument replacement refuses lost interior comments and ambiguous chains", () => {
  assert.equal(preserveResourceBuilderComments('resource.value({ dev: /* intent */ "true", prod: "false" })', 'resource.value({ dev: "false", prod: "false" })'), undefined);
  assert.equal(preserveResourceBuilderComments('resource.value({ dev: /* intent */ "true", prod: "false" })', 'resource.value({ dev: /* intent */ "false", prod: "false" })'), 'resource.value({ dev: /* intent */ "false", prod: "false" })');
  assert.equal(preserveResourceBuilderComments('resource.value(/* source */ "true").required("dev").required("prod")', 'resource.value("true").required()'), undefined);
  assert.equal(preserveResourceBuilderComments('resource.value(/* source */ "true"); other()', 'resource.value("true")'), undefined);
});
