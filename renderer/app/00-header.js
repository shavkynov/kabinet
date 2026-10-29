import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { TypeSounds } from './sounds.js';
import { Ambient, AMBIENTS } from './ambient.js';
import { createList } from './lists.js';
import { createCardView } from './cards.js';
import { NameLinks, setNameLinks, wireLinkHover } from './links.js';
import { showMenu, closeMenu, ICONS_CHARACTER, ICONS_PLACE } from './menu.js';
import { t, tdom, LANG, LOCALE, initDomTranslation, initKeyLabels, setTermsMode, applyTermsDom } from './i18n.js';
import { LangIssues, initTextCheck } from './textcheck.js';
import { TypeAnim } from './typeanim.js';
import { HiddenMarks, refreshMarks } from './marks.js';
import { Comments, commentRanges, setCommentRanges, addCommentRange, removeCommentRange, setActiveComment } from './comments.js';
import { TextAnalysis, refreshAnalysis, scanTense, scanRhythm, analysisRanges, analysisAt, stepIndex, AN_CATS, AN_NAV_CATS } from './analysis.js';
import { Typography, fixDocTypography } from './typo.js';
import { Slice, Fragment } from '@tiptap/pm/model';
import { isOfficeHtml, officeTextToParagraphs } from '../src/paste.js';
import { clipboardPlain } from '../src/clip.js';
import { authorSheets } from '../src/terms.js';
import { DEFAULT_FILLERS, cleanFiller, cleanFillerList, skipKey } from '../src/editing.js';

const api = window.kabinet;
const sounds = new TypeSounds();
const ambient = new Ambient(sounds);
const $ = (sel) => document.querySelector(sel);

const SAVE_DELAY_MS = 1500;

