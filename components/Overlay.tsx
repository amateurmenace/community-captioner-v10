import React, { useEffect, useRef, useState } from 'react';
import { OverlaySettings } from '../types';
import { ArrowLeft, WifiOff } from 'lucide-react';

interface OverlayProps {
  currentCaption: string;
  isPartial: boolean;
  settings: OverlaySettings;
  onBack?: () => void;
  status?: 'connected' | 'disconnected'; // New Prop for Relay Status
}

const Overlay: React.FC<OverlayProps> = ({ currentCaption, isPartial, settings, onBack, status }) => {
  const [showControls, setShowControls] = useState(false);

  // Force transparent background for OBS
  useEffect(() => {
      // Save original styles
      const originalBodyBg = document.body.style.backgroundColor;
      const originalHtmlBg = document.documentElement.style.backgroundColor;
      
      // Apply transparency strongly
      document.body.style.setProperty('background-color', 'transparent', 'important');
      document.documentElement.style.setProperty('background-color', 'transparent', 'important');
      
      return () => {
          // Restore on unmount
          document.body.style.backgroundColor = originalBodyBg;
          document.documentElement.style.backgroundColor = originalHtmlBg;
      };
  }, []);

  const LINE_HEIGHT_EM = 1.5;
  const PADDING_PX = 32; // 1rem top + 1rem bottom = 32px (assuming root 16px)

  // Calculate precise height based on line count
  // Height = (fontSize * lineHeight * maxLines) + Padding
  // We subtract 1px to prevent any sub-pixel rendering bleeding
  const contentHeight = (settings.fontSize * LINE_HEIGHT_EM * settings.maxLines);
  const containerHeight = contentHeight + PADDING_PX;

  const boxStyle: React.CSSProperties = {
    position: 'absolute',
    left: `${settings.x}%`,
    top: `${settings.y}%`,
    width: `${settings.width}%`,
    backgroundColor: settings.backgroundColor,
    color: settings.color,
    fontFamily: settings.fontFamily,
    fontSize: `${settings.fontSize}px`,
    lineHeight: LINE_HEIGHT_EM,
    textAlign: settings.textAlign,
    padding: '16px', // 1rem
    borderRadius: '12px',
    boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-end', // Pushes text to bottom
    height: `${containerHeight}px`,
    boxSizing: 'border-box',
    overflow: 'hidden',
    transition: 'all 0.15s ease-out'
  };

  return (
    <div 
        className="w-full h-screen relative obs-transparent overflow-hidden"
        style={{ backgroundColor: 'transparent' }}
        onMouseEnter={() => setShowControls(true)}
        onMouseLeave={() => setShowControls(false)}
    >
      {onBack && (
          <div className={`absolute top-4 right-4 z-50 transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0'}`}>
              <button 
                onClick={onBack}
                className="bg-stone-900/80 hover:bg-forest-dark text-white px-4 py-2 rounded-full font-bold text-sm flex items-center gap-2 backdrop-blur-sm shadow-lg"
              >
                  <ArrowLeft size={16} /> Return to Dashboard
              </button>
          </div>
      )}

      {/* Disconnected Indicator - Helps debugging in OBS */}
      {status === 'disconnected' && (
          <div className="absolute top-4 left-4 z-50 bg-red-500/80 text-white px-3 py-1 rounded-full text-xs font-bold flex items-center gap-2 backdrop-blur-md animate-pulse">
              <WifiOff size={12} /> Relay Disconnected
          </div>
      )}

      {/* The Container */}
      <div style={boxStyle}>
        {/* Content Wrapper 
            This inner div helps enforce the clipping of top lines.
            We set max-height to the content height (minus padding).
            Because the parent is justify-end, this box sits at the bottom.
            Any text overflowing *above* this height is hidden by the parent's overflow:hidden.
        */}
        <div style={{ maxHeight: `${contentHeight}px`, overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
             <p 
              className="font-semibold tracking-wide break-words whitespace-pre-wrap"
              style={{ margin: 0 }}
             >
            {currentCaption}
            {isPartial && <span className="opacity-50 animate-pulse">_</span>}
            </p>
        </div>
      </div>
    </div>
  );
};

export default Overlay;