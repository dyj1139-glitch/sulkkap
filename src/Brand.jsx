export default function Brand({ className = '' }) {
  return <span className={`receipt-logo ${className}`} role="img" aria-label="술깝">
    <span aria-hidden="true">술깝</span>
  </span>;
}
