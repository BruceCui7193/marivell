; Windows installer: optional Markdown file association.
; Defaults to checked, and registers Open With entries for .md / .markdown.
; Custom association icons are copied into the app resources by win.extraResources.
!include FileAssociation.nsh
!include LogicLib.nsh
!include nsDialogs.nsh

Var AssociateMarkdown
Var AssociateCheckbox

!macro customInit
  StrCpy $AssociateMarkdown "1"
!macroend

Function showAssociationPage
  StrCmp $AssociateMarkdown "" 0 +2
  StrCpy $AssociateMarkdown "1"

  nsDialogs::Create 1018
  Pop $0
  StrCmp $0 error 0 +2
  Abort

  ${NSD_CreateLabel} 0 0 100% 24u "Choose whether Markdown files should be associated with Markdown Editor Pro."
  Pop $0
  ${NSD_CreateCheckbox} 0 32u 100% 12u "Associate .md / .markdown files with Markdown Editor Pro"
  Pop $AssociateCheckbox

  ${If} $AssociateMarkdown == "1"
    ${NSD_Check} $AssociateCheckbox
  ${Else}
    ${NSD_Uncheck} $AssociateCheckbox
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function validateAssociationPage
  ${NSD_GetState} $AssociateCheckbox $AssociateMarkdown
FunctionEnd

Page custom showAssociationPage validateAssociationPage

!macro customInstall
  ${If} $AssociateMarkdown == "1"
    !insertmacro APP_ASSOCIATE "md" "MarkdownEditorPro.md" "Markdown Document" "$INSTDIR\resources\md.ico" "Open with Markdown Editor Pro" '"$appExe" "%1"'
    !insertmacro APP_ASSOCIATE "markdown" "MarkdownEditorPro.md" "Markdown Document" "$INSTDIR\resources\markdown.ico" "Open with Markdown Editor Pro" '"$appExe" "%1"'
    !insertmacro UPDATEFILEASSOC
  ${EndIf}
!macroend

!macro unregisterFileAssociations
  !insertmacro APP_UNASSOCIATE "md" "MarkdownEditorPro.md"
  !insertmacro APP_UNASSOCIATE "markdown" "MarkdownEditorPro.md"
  !insertmacro UPDATEFILEASSOC
!macroend
