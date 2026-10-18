#!/usr/bin/env node
// The CDK app's entry point (cdk.json "app"). It decides which deployment and
// graph this synth builds before anything imports the resource catalog, then
// loads the application itself: bin/cdk-app.ts, where your stacks go.
import { frameworkApp } from "./app";

frameworkApp();
require("./cdk-app");
