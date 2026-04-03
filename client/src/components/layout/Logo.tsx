import { Link } from 'react-router-dom';

export default function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2.5 group">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 32 32"
        fill="none"
        className="w-8 h-8"
        aria-hidden="true"
      >
        <rect
          x="4"
          y="2"
          width="20"
          height="28"
          rx="3"
          className="fill-indigo-100 stroke-indigo-600"
          strokeWidth="1.5"
        />
        <rect
          x="8"
          y="6"
          width="20"
          height="24"
          rx="3"
          className="fill-white stroke-indigo-600"
          strokeWidth="1.5"
        />
        <path
          d="M13 18l2.5 2.5L20 16"
          className="stroke-emerald-500"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        <line x1="13" y1="12" x2="23" y2="12" className="stroke-slate-300" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="13" y1="24" x2="20" y2="24" className="stroke-slate-300" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <span className="text-xl font-bold text-slate-900 transition-colors duration-150 group-hover:text-indigo-600">
        СтройСверка
      </span>
    </Link>
  );
}
