import { connect } from '../remote'
import { renderApp } from './render'

const root = document.getElementById('app')
if (root) renderApp(root, connect(location.href))
