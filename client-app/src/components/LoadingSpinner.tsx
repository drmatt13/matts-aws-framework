import { LoaderCircle } from "lucide-react";

const LoadingSpinner = () => {
  return (
    <div className="animate-spin">
      <LoaderCircle className="h-4 w-4" />
    </div>
  );
};

export default LoadingSpinner;
