/** Inspect the deployed graph, independent of the current source and intended retention. */
export function statefulTeardownConsequences(templates: ReadonlyMap<string, any>): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const retained = (resource: any) => resource && ["Retain", "RetainExceptOnCreate"].includes(resource.DeletionPolicy);
  const resources = new Map<string, { stack: string; logicalId: string; resource: any }>();
  const exports = new Map<string, string>();
  for (const [stack, template] of templates) {
    const external = template.Metadata?.["framework:stateful-reference"];
    if (external?.kind === "database") warnings.push(`${stack}: external referenced database ${external.reference?.instanceIdentifier ?? "(unknown)"}, its original VPC and credentials remain outside this stack's management and keep their costs. New connection security groups/ingress are removed; this teardown does not delete or import the external database.`);
    if (external?.kind === "cognito") warnings.push(`${stack}: externally referenced User Pool ${external.reference?.userPoolId ?? "(unknown)"}, its users, selected client and domain remain outside this stack's management. This teardown does not delete the external pool or repair its dependent configuration.`);
    for (const [logicalId, resource] of Object.entries<any>(template.Resources ?? {})) resources.set(stack + "/" + logicalId, { stack, logicalId, resource });
    for (const output of Object.values<any>(template.Outputs ?? {})) {
      const logicalId = output.Value?.Ref ?? output.Value?.["Fn::GetAtt"]?.[0];
      if (typeof output.Export?.Name === "string" && typeof logicalId === "string") exports.set(output.Export.Name, stack + "/" + logicalId);
    }
  }
  const references = (stack: string, value: any): Set<string> => {
    const result = new Set<string>();
    const scan = (node: any): void => {
      if (!node || typeof node !== "object") return;
      if (typeof node.Ref === "string" && resources.has(stack + "/" + node.Ref)) result.add(stack + "/" + node.Ref);
      const att = node["Fn::GetAtt"];
      const id = typeof att === "string" ? att.split(".")[0] : Array.isArray(att) ? att[0] : undefined;
      if (typeof id === "string" && resources.has(stack + "/" + id)) result.add(stack + "/" + id);
      if (typeof node["Fn::ImportValue"] === "string" && exports.has(node["Fn::ImportValue"])) result.add(exports.get(node["Fn::ImportValue"])!);
      const sub = typeof node["Fn::Sub"] === "string" ? node["Fn::Sub"] : Array.isArray(node["Fn::Sub"]) ? node["Fn::Sub"][0] : undefined;
      if (typeof sub === "string") for (const match of sub.matchAll(/\$\{([^!}][^}.]*)(?:\.[^}]*)?\}/g)) if (resources.has(stack + "/" + match[1])) result.add(stack + "/" + match[1]);
      Object.values(node).forEach(scan);
    };
    scan(value); return result;
  };
  const durableDatabaseTypes = /^(AWS::EC2::(?:VPC|VPCCidrBlock|Subnet|RouteTable|SubnetRouteTableAssociation|Route|InternetGateway|VPCGatewayAttachment|EgressOnlyInternetGateway|SecurityGroup|SecurityGroupIngress|SecurityGroupEgress|VPCEndpoint|NatGateway|EIP)|AWS::RDS::(?:DBSubnetGroup|DBParameterGroup)|AWS::KMS::Key|AWS::SecretsManager::(?:Secret|SecretTargetAttachment))$/;
  for (const [identity, entry] of resources) {
    const { stack, resource } = entry;
    if (!retained(resource)) continue;
    if (resource.Type === "AWS::RDS::DBInstance") {
      const visited = new Set<string>();
      visited.add(identity);
      // Both directions matter: associations reference the retained subnet/VPC,
      // while gateways and addresses are referenced by those associations/routes.
      let changed = true;
      while (changed) {
        changed = false;
        for (const [candidate, dependency] of resources) {
          if (candidate !== identity && !durableDatabaseTypes.test(dependency.resource.Type)) continue;
          const outgoing = references(dependency.stack, dependency.resource.Properties);
          if (visited.has(candidate)) for (const next of outgoing) {
            if (durableDatabaseTypes.test(resources.get(next)!.resource.Type) && !visited.has(next)) { visited.add(next); changed = true; }
          }
          else if ([...outgoing].some(id => visited.has(id))) { visited.add(candidate); changed = true; }
        }
      }
      for (const candidate of visited) {
        const target = resources.get(candidate)!;
        if (candidate !== identity && !retained(target.resource)) blockers.push(`Retained database ${identity} depends on ${candidate} (${target.resource.Type}), which teardown would delete. Deploy retention for its network, subnet group, security groups, encryption and credentials before teardown.`);
      }
      warnings.push(`${identity}: retained RDS and retained network services continue to incur charges. Retention does not prove IAM app_user/schema connectivity or snapshot recovery.`);
    }
    if (resource.Type === "AWS::Cognito::UserPool") {
      for (const [trigger, value] of Object.entries<any>(resource.Properties?.LambdaConfig ?? {})) {
        const targets = [...references(stack, value)];
        const functionTargets = targets.filter(target => /^AWS::Lambda::(?:Function|Alias|Version)$/.test(resources.get(target)!.resource.Type));
        if (trigger !== "KMSKeyID" && functionTargets.length === 0) blockers.push(`Retained User Pool ${identity} trigger ${trigger} has an external or unresolved identity. Teardown cannot prove its dependency survival. Reconfigure the trigger through a reviewed pool update or establish explicit retained deployment references before teardown.`);
        const visited = new Set<string>(targets);
        let changed = true;
        while (changed) {
          changed = false;
          for (const [candidate, dependency] of resources) {
            const outgoing = references(dependency.stack, dependency.resource.Properties);
            if (visited.has(candidate)) {
              for (const next of outgoing) if (!visited.has(next) && next !== identity) { visited.add(next); changed = true; }
            } else if ((dependency.resource.Type === "AWS::IAM::Policy" || dependency.resource.Type === "AWS::Lambda::Permission" || durableDatabaseTypes.test(dependency.resource.Type)) && [...outgoing].some(id => visited.has(id))) {
              visited.add(candidate); changed = true;
            }
          }
        }
        for (const target of visited) {
          const dependency = resources.get(target)!;
          if (target !== identity && !retained(dependency.resource)) blockers.push(`Retained User Pool ${identity} trigger ${trigger} depends on ${target} (${dependency.resource.Type}), which teardown would delete. Preserve its function, IAM role/policies, invoke permission, layers, encryption and network dependencies, or reconfigure the trigger in a separately reviewed pool update before teardown.`);
        }
      }
      const triggers = resource.Properties?.LambdaConfig;
      if (triggers && Object.keys(triggers).length) warnings.push(`${identity}: Lambda triggers and their dependencies must remain available; a retained pool does not recreate them. Unresolved external trigger identities block automatic teardown; runtime behavior still needs independent verification.`);
      const children = [...resources].filter(([, child]) => child.resource.Type.startsWith("AWS::Cognito::") && child.resource.Type !== "AWS::Cognito::UserPool" && references(child.stack, child.resource.Properties).has(identity));
      const removed = children.filter(([, child]) => !retained(child.resource)).map(([key]) => key);
      if (removed.length) warnings.push(`${identity}: users survive in the pool, but teardown deletes related resources: ${removed.join(", ")}. Recovery must select a surviving client/domain or recreate them separately.`);
    }
  }
  return { blockers: [...new Set(blockers)], warnings: [...new Set(warnings)] };
}
