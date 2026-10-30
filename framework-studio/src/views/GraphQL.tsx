import { DocumentCard, pageWidthClasses } from "./DocumentUI";

export function GraphQL() {
  return <div className={`${pageWidthClasses} py-6`}>
    <h1 className="mt-0 mb-6 font-condensed text-step2 font-semibold">GraphQL</h1>
    <DocumentCard>
      <h2>Coming soon</h2>
      <p>GraphQL tools will be available here.</p>
    </DocumentCard>
  </div>;
}
