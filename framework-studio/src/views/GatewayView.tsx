import type { ModelGateway } from "../../shared/gateways";
import { useStudio } from "../studio";
import { developmentLocation, environments } from "../deployment";
import { EntityIcon } from "./EntityIcon";
import { DeploymentSection, DeploymentOwnership } from "./Deployment";
import { Description } from "./Description";
import { InspectorDisclosure } from "./InspectorUI";
import { FrameworkManagedStatus } from "./ResourceStatus";
import { Written } from "./Written";

export function GatewayView({ gateway }: { readonly gateway: ModelGateway }) {
  const { model, snapshot, select } = useStudio();
  const dev = snapshot.models.dev.gateways?.find(item => item.id === gateway.id) ?? gateway;
  const prod = snapshot.models.prod.gateways?.find(item => item.id === gateway.id) ?? gateway;
  const routes = model.routes.filter(route => gateway.routes.includes(route.id));
  const stack = model.resources.find(resource => resource.id === gateway.stackResource);
  return <>
    <header><span className="kind">Amazon API Gateway</span><h2><EntityIcon icon="gateway" />{gateway.title}</h2><FrameworkManagedStatus /><Written location={stack?.stackOutputs?.[0]?.source} label="Defined in" /></header>
    <DeploymentSection availability={{ dev: environments(dev.lanes).dev, prod: prod.lanes.prod }} locations={{ dev: developmentLocation(dev.lanes), prod: "In AWS" }}><DeploymentOwnership reason="The framework manages this gateway. Configure Deploy on its handlers to control where they run." owners={[...new Set(routes.map(route => route.target))].map(ref => ({ id: ref, title: model.targets.find(target => target.ref === ref)?.title ?? ref }))} /></DeploymentSection>
    <Description entity={gateway.id} />
    <InspectorDisclosure title="Routes" count={routes.length} defaultOpen><ul className="relations">{routes.map(route => <li key={route.id}><span><button className="linkish code" onClick={() => select(route.id)}>{route.methods === "*" ? "ANY " : route.methods ? `${route.methods.join(", ")} ` : ""}{route.browserPath ?? route.path}</button><span className="small muted"> · {route.auth ? "Authenticated" : "Public"}</span><br /><button className="linkish small" onClick={() => select(route.target)}>{model.targets.find(target => target.ref === route.target)?.id ?? route.target}</button></span></li>)}</ul></InspectorDisclosure>
    {gateway.authorizer ? <InspectorDisclosure title="Connection authorizer" defaultOpen><button className="linkish" onClick={() => select(gateway.authorizer)}>{model.targets.find(target => target.ref === gateway.authorizer)?.id ?? gateway.authorizer}</button><p className="small muted">Guards the $connect handshake wherever these routes are enabled.</p></InspectorDisclosure> : null}
    {stack?.stackOutputs?.length ? <InspectorDisclosure title="CloudFormation outputs" count={stack.stackOutputs.length}><ul className="relations">{stack.stackOutputs.map(output => <li key={output.name}><span>{output.name}<br /><code className="small muted">{output.symbol} → {output.envName}</code></span></li>)}</ul></InspectorDisclosure> : null}
  </>;
}
