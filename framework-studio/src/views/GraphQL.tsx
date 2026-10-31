import { DocumentCard, pageWidthClasses } from "./DocumentUI";

export function GraphQL() {
  return (
    <div className={`${pageWidthClasses} py-6`}>
      <h1 className="mt-0 mb-6 font-condensed text-step2 font-semibold">GraphQL</h1>
      <DocumentCard>
        <h2 className="mt-0 mb-2 text-[15px] leading-[1.4]">Coming soon</h2>
        <p className="text-label leading-[1.5]">GraphQL tools will be available here.</p>
      </DocumentCard>
    </div>
  );
}
