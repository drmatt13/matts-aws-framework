import { DocumentCard, PageToolbar, documentTitleClasses, documentProseClasses, pageBodyClasses, pageTitleClasses } from "./DocumentUI";

export function GraphQL() {
  return (
    <>
      <PageToolbar>
        <h1 className={pageTitleClasses}>GraphQL</h1>
      </PageToolbar>
      <div className={pageBodyClasses}>
        <DocumentCard>
          <h2 className={documentTitleClasses}>Coming soon</h2>
          <p className={documentProseClasses}>GraphQL tools will be available here.</p>
        </DocumentCard>
      </div>
    </>
  );
}
