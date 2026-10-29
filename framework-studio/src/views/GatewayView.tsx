import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import { inspectorRelationListClasses } from "../inspector-ui";
import type { ModelGateway } from "../../shared/gateways";
import { useStudio } from "../studio";
import { developmentLocation, environments } from "../deployment";
import { EntityIcon } from "./EntityIcon";
import { DeploymentSection, DeploymentOwnership } from "./Deployment";
import { Description } from "./Description";
import { Tags } from "./Tags";
import { InspectorDisclosure, InspectorKind } from "./InspectorUI";
import { FrameworkManagedStatus } from "./ResourceStatus";
import { Written } from "./Written";

export function GatewayView({ gateway }: { readonly gateway: ModelGateway }) {
  const { model, snapshot, select } = useStudio();
  const dev = snapshot.models.dev.gateways?.find(item => item.id === gateway.id) ?? gateway;
  const prod = snapshot.models.prod.gateways?.find(item => item.id === gateway.id) ?? gateway;
  const routes = model.routes.filter(route => gateway.routes.includes(route.id));
  const stack = model.resources.find(resource => resource.id === gateway.stackResource);
  const availability = { dev: environments(dev.lanes).dev, prod: prod.lanes.prod };
  const locations = { dev: developmentLocation(dev.lanes), prod: "In AWS" };
  return <>
    <header><InspectorKind environments={{ availability, descriptions: locations, unavailableDescription: "not enabled" }}>Amazon API Gateway</InspectorKind><h2><EntityIcon icon="gateway" />{gateway.title}</h2><FrameworkManagedStatus /><Written location={stack?.stackOutputs?.[0]?.source} label="Defined in" /></header>
    <Tags entity={gateway.stackResource} />
    <Description entity={gateway.id} />
    <DeploymentSection availability={availability} locations={locations}><DeploymentOwnership reason="The framework manages this gateway. Configure Deploy on its handlers to control where they run." owners={[...new Set(routes.map(route => route.target))].map(ref => ({ id: ref, title: model.targets.find(target => target.ref === ref)?.title ?? ref }))} /></DeploymentSection>
    <InspectorDisclosure title="Routes" count={routes.length} defaultOpen><ul className={inspectorRelationListClasses} data-slot="relations">{routes.map(route => <li key={route.id}><span><button className={cx(buttonClasses({ variant: "link" }), "font-mono text-[.86em]")} onClick={() => select(route.id)}>{route.methods === "*" ? "ANY " : route.methods ? `${route.methods.join(", ")} ` : ""}{route.browserPath ?? route.path}</button><span className={"text-caption text-graphite"}> · {route.auth ? "Authenticated" : "Public"}</span><br /><button className={cx(buttonClasses({ variant: "link" }), "text-caption")} onClick={() => select(route.target)}>{model.targets.find(target => target.ref === route.target)?.id ?? route.target}</button></span></li>)}</ul></InspectorDisclosure>
    {gateway.authorizer ? <InspectorDisclosure title="Connection authorizer" defaultOpen><button className={buttonClasses({ variant: "link" })} onClick={() => select(gateway.authorizer)}>{model.targets.find(target => target.ref === gateway.authorizer)?.id ?? gateway.authorizer}</button><p className={"text-caption text-graphite"}>Guards the $connect handshake wherever these routes are enabled.</p></InspectorDisclosure> : null}
    {stack?.stackOutputs?.length ? <InspectorDisclosure title="CloudFormation outputs" count={stack.stackOutputs.length}><ul className={inspectorRelationListClasses} data-slot="relations">{stack.stackOutputs.map(output => <li key={output.name}><span>{output.name}<br /><code className={"text-caption text-graphite"}>{output.symbol} → {output.envName}</code></span></li>)}</ul></InspectorDisclosure> : null}
  </>;
}
