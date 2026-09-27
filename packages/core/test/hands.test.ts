import { describe, expect, it } from 'vitest';
import { computerTask, findNamed, numberIn, parseClipboard, parseFiles, parseKeys, parseMedia, parseShortcutRequest, parseSystem, parseUi, parseWindow } from '../src/hands.ts';

describe('numbers', () => {
  it.each([
    ['volume to 30', 30],
    ['set it to thirty five percent', 35],
    ['a hundred', 100],
    ['half way', 50],
    ['turn it up', null],
    ['this one', null],
  ])('%s → %s', (text, n) => expect(numberIn(text)).toBe(n));
});

describe('system settings', () => {
  it.each([
    ['turn the volume up', { setting: 'volume', action: 'up', value: 10 }],
    ['louder', { setting: 'volume', action: 'up', value: 10 }],
    ['turn it up a bit', { setting: 'volume', action: 'up', value: 5 }],
    ['make it a lot quieter', { setting: 'volume', action: 'down', value: 25 }],
    ['set the volume to 30', { setting: 'volume', action: 'set', value: 30 }],
    ['volume 50 percent', { setting: 'volume', action: 'set', value: 50 }],
    ['turn the volume down by 20', { setting: 'volume', action: 'down', value: 20 }],
    ['max volume', { setting: 'volume', action: 'set', value: 100 }],
    ['mute the sound', { setting: 'volume', action: 'mute' }],
    ['unmute', { setting: 'volume', action: 'unmute' }],
    ["what's the volume", { setting: 'volume', action: 'query' }],
    ['dim the screen', { setting: 'brightness', action: 'down', value: 10 }],
    ['make the screen brighter', { setting: 'brightness', action: 'up', value: 10 }],
    ['brightness to 70%', { setting: 'brightness', action: 'set', value: 70 }],
    ['turn on dark mode', { setting: 'dark-mode', action: 'on' }],
    ['switch to light mode', { setting: 'dark-mode', action: 'off' }],
    ['is dark mode on', { setting: 'dark-mode', action: 'query' }],
    ['toggle dark mode', { setting: 'dark-mode', action: 'toggle' }],
    ['turn off wifi', { setting: 'wifi', action: 'off' }],
    ['turn the wi-fi back on', { setting: 'wifi', action: 'on' }],
    ['is wifi on', { setting: 'wifi', action: 'query' }],
    ['disable bluetooth', { setting: 'bluetooth', action: 'off' }],
    ['turn on do not disturb', { setting: 'focus', action: 'on' }],
    ['turn off focus mode', { setting: 'focus', action: 'off' }],
    ['lock my screen', { setting: 'lock', action: 'now' }],
    ['lock the mac', { setting: 'lock', action: 'now' }],
    ['put the mac to sleep', { setting: 'sleep', action: 'now' }],
    ['how much battery do i have', { setting: 'battery', action: 'query' }],
    ['is my laptop charging', { setting: 'battery', action: 'query' }],
  ])('%s', (text, want) => expect(parseSystem(text)).toEqual(want));

  it('leaves alone what is about something else', () => {
    expect(parseSystem('go to sleep')).toBeNull(); // Nova's microphone
    expect(parseSystem('open spotify')).toBeNull();
    expect(parseSystem('focus on the window')).toBeNull();
  });
});

describe('media', () => {
  it.each([
    ['pause', { action: 'pause' }],
    ['pause the music', { action: 'pause' }],
    ['stop the music', { action: 'pause' }],
    ['resume', { action: 'play' }],
    ['play', { action: 'play' }],
    ['next song', { action: 'next' }],
    ['skip this track', { action: 'next' }],
    ['previous track', { action: 'previous' }],
    ['go back a song', { action: 'previous' }],
    ["what's playing", { action: 'now-playing' }],
    ['what song is this', { action: 'now-playing' }],
    ['play some jazz', { action: 'play-query', query: 'jazz' }],
    ['play taylor swift on spotify', { action: 'play-query', query: 'taylor swift', app: 'Spotify' }],
    ['play my running playlist', { action: 'play-query', query: 'running playlist' }],
    ['pause spotify', { action: 'pause', app: 'Spotify' }],
  ])('%s', (text, want) => expect(parseMedia(text)).toEqual(want));

  it("doesn't take Nova's own microphone", () => {
    expect(parseMedia('pause the microphone')).toBeNull();
    expect(parseMedia('open music')).toBeNull();
  });
});

describe('windows', () => {
  const apps = ['Safari', 'Slack', 'Mail', 'Visual Studio Code', 'Notes'];
  it.each([
    ['put safari on the left', { action: 'place', placements: [{ app: 'Safari', position: 'left' }] }],
    ['move this window to the right half', { action: 'place', placements: [{ app: undefined, position: 'right' }] }],
    ['maximize slack', { action: 'place', placements: [{ app: 'Slack', position: 'maximize' }] }],
    ['center the window', { action: 'place', placements: [{ app: undefined, position: 'center' }] }],
    ['put mail in the top right corner', { action: 'place', placements: [{ app: 'Mail', position: 'top-right' }] }],
    ['safari on the left and slack on the right', { action: 'place', placements: [{ app: 'Safari', position: 'left' }, { app: 'Slack', position: 'right' }] }],
    ['vs code left two thirds, notes right third', { action: 'place', placements: [{ app: 'Visual Studio Code', position: 'left-two-thirds' }, { app: 'Notes', position: 'right-third' }] }],
    ['make this full screen', { action: 'fullscreen', app: undefined }],
    ['exit full screen', { action: 'exit-fullscreen', app: undefined }],
    ['minimize slack', { action: 'minimize', app: 'Slack' }],
    ['hide slack', { action: 'hide', app: 'Slack' }],
    ['move safari to the other screen', { action: 'other-display', app: 'Safari' }],
    ['save this layout as work', { action: 'save-layout', layout: 'work' }],
    ['save my windows as coding', { action: 'save-layout', layout: 'coding' }],
    ['set up my work layout', { action: 'layout', layout: 'work' }],
    ['coding layout', { action: 'layout', layout: 'coding' }],
    ['what windows are open', { action: 'list' }],
  ])('%s', (text, want) => expect(parseWindow(text, apps)).toEqual(want));

  it('is not about windows otherwise', () => {
    expect(parseWindow('open safari', apps)).toBeNull();
    expect(parseWindow('turn left at the lights', apps)).toBeNull();
  });
});

describe('keys and the app in front', () => {
  it.each([
    ['press command s', { keys: 'cmd+s', count: 1 }],
    ['command shift t', { keys: 'shift+cmd+t', count: 1 }],
    ['hit enter', { keys: 'return', count: 1 }],
    ['press escape', { keys: 'escape', count: 1 }],
    ['press the down arrow twice', { keys: 'down', count: 2 }],
    ['control c', { keys: 'ctrl+c', count: 1 }],
    ['press tab 3 times', { keys: 'tab', count: 3 }],
    ['press f5', { keys: 'f5', count: 1 }],
  ])('%s', (text, want) => expect(parseKeys(text)).toEqual(want));

  it.each([
    ['click send', { action: 'click', target: 'send' }],
    ['click on the reply button', { action: 'click', target: 'reply' }],
    ['double click the report', { action: 'double-click', target: 'report' }],
    ['right click the icon', { action: 'right-click', target: 'icon' }],
    ['type hello world', { action: 'type', text: 'hello world' }],
    ['type "Dear John" and press enter', { action: 'type', text: 'Dear John', submit: true }],
    ['press command s', { action: 'key', keys: 'cmd+s', count: 1 }],
    ['scroll down', { action: 'scroll', direction: 'down', amount: 6 }],
    ['scroll up a bit', { action: 'scroll', direction: 'up', amount: 2 }],
    ['scroll to the top', { action: 'scroll', direction: 'top', amount: 6 }],
    ['go to the bottom of the page', { action: 'scroll', direction: 'bottom', amount: 6 }],
    ['select all', { action: 'select-all' }],
  ])('%s', (text, want) => expect(parseUi(text)).toEqual(want));

  it('keeps the words of what to type as said', () => {
    expect(parseUi('Type Meet me at 5 PM')).toEqual({ action: 'type', text: 'Meet me at 5 PM' });
  });
});

describe('files', () => {
  it.each([
    ['find my resume', { action: 'find', query: 'resume', kind: undefined, folder: undefined, days: undefined }],
    ['where is the budget spreadsheet', { action: 'find', query: 'budget', kind: 'spreadsheet' }],
    ['find pdfs from last week', { action: 'find', query: undefined, kind: 'pdf', folder: undefined, days: 7 }],
    ['open the invoice from yesterday', { action: 'open', query: 'invoice', kind: undefined, folder: undefined, days: 2 }],
    ['show me my recent files', { action: 'recent', kind: undefined, folder: undefined, days: 7 }],
    ['what did i download today', { action: 'recent', kind: undefined, folder: 'downloads', days: 1 }],
    ['reveal the report in finder', { action: 'reveal', query: 'report', kind: undefined }],
    ['move the budget file to documents', { action: 'move', query: 'budget', kind: undefined, destination: 'documents' }],
    ['rename report.pdf to final report', { action: 'rename', query: 'report.pdf', kind: undefined, newName: 'final report' }],
    ['trash the screenshot on my desktop', { action: 'trash', query: undefined, kind: 'image', folder: 'desktop', days: undefined }],
    ['summarize the pdf in my downloads', { action: 'read', query: undefined, kind: 'pdf', folder: 'downloads' }],
  ])('%s', (text, want) => expect(parseFiles(text)).toEqual(want));

  it("isn't about files otherwise", () => {
    expect(parseFiles('delete that memory')).toBeNull();
    expect(parseFiles('open slack')).toBeNull();
    expect(parseFiles('move safari to the left')).toBeNull();
  });
});

describe('the clipboard, shortcuts and computer tasks', () => {
  it.each([
    ["what's on my clipboard", { action: 'read' }],
    ['what did i copy', { action: 'read' }],
    ['copy that', { action: 'copy-reply' }],
    ['copy your answer', { action: 'copy-reply' }],
    ['copy the link', { action: 'copy-page' }],
    ['copy "hello there"', { action: 'copy-text', text: 'hello there' }],
  ])('%s', (text, want) => expect(parseClipboard(text)).toEqual(want));

  const shortcuts = ['Log Water', 'Morning Routine', 'Translate', 'Do Not Disturb On'];
  it.each([
    ['run my log water shortcut', { action: 'run', name: 'Log Water' }],
    ['run the morning routine shortcut', { action: 'run', name: 'Morning Routine' }],
    ['run translate with good morning', { action: 'run', name: 'Translate', input: 'good morning' }],
    ['what shortcuts do i have', { action: 'list' }],
    ['run the shortcut called nothing like it', { action: 'run' }],
  ])('%s', (text, want) => expect(parseShortcutRequest(text, shortcuts)).toEqual(want));

  it('reads the task out of "use the computer to …"', () => {
    expect(computerTask('use the computer to book a table at Nobu for two')).toBe('book a table at Nobu for two');
    expect(computerTask('can you take over and fill in this form for me')).toBe('fill in this form');
    expect(computerTask('order more coffee pods on the computer')).toBe('order more coffee pods');
  });

  it('finds names loosely, the longest when several fit', () => {
    expect(findNamed('put vs code on the left', ['Visual Studio Code', 'Code'])).toBe('Visual Studio Code');
    expect(findNamed('nothing here', ['Safari'])).toBeNull();
  });
});
